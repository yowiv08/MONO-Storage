import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DEFAULT_LOGIN_RATE_LIMIT, normalizeLoginRateLimit } from '../shared/login-rate-limit.ts'
import { enforceLoginRateLimit, LoginRateLimiter, LoginRateLimitError } from '../worker/login-rate-limit.ts'

function sqlState(database: DatabaseSync) {
  const alarms: number[] = []
  const state = {
    storage: {
      sql: {
        exec(query: string, ...values: SQLInputValue[]) {
          if (query.trim().startsWith('CREATE TABLE')) {
            database.exec(query)
            return { toArray: () => [], one: () => { throw new Error('No rows') } }
          }
          const statement = database.prepare(query)
          const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
          return {
            toArray: () => rows,
            one: () => { assert.equal(rows.length, 1); return rows[0] },
          }
        },
      },
      transactionSync<T>(run: () => T): T {
        database.exec('BEGIN IMMEDIATE')
        try { const result = run(); database.exec('COMMIT'); return result }
        catch (error) { database.exec('ROLLBACK'); throw error }
      },
      async setAlarm(time: number) { alarms.push(time) },
    },
  }
  return { state, alarms }
}

function checkRequest(policy = { maxAttempts: 2, windowSeconds: 10 }, version = 0, consume?: boolean) {
  return new Request('https://login-rate-limit.internal/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy, version, ...(consume === undefined ? {} : { consume }) }) })
}

async function decision(limiter: LoginRateLimiter, policy = { maxAttempts: 2, windowSeconds: 10 }, version = 0, consume?: boolean) {
  const response = await limiter.fetch(checkRequest(policy, version, consume))
  assert.equal(response.status, 200)
  return response.json() as Promise<{ allowed: boolean; retryAfter: number }>
}

test('Login policy has mandatory bounded integer fields and independent default values', () => {
  assert.deepEqual(normalizeLoginRateLimit(undefined), DEFAULT_LOGIN_RATE_LIMIT)
  const first = normalizeLoginRateLimit(undefined)
  first.maxAttempts = 1
  assert.equal(normalizeLoginRateLimit(undefined).maxAttempts, 10)
  for (const value of [null, false, [], {}, { maxAttempts: 10 }, { maxAttempts: 0, windowSeconds: 60 }, { maxAttempts: 101, windowSeconds: 60 }, { maxAttempts: 1.5, windowSeconds: 60 }, { maxAttempts: '10', windowSeconds: 60 }, { maxAttempts: 10, windowSeconds: 9 }, { maxAttempts: 10, windowSeconds: 3601 }, { maxAttempts: 10, windowSeconds: Infinity }, { maxAttempts: 10, windowSeconds: 60, enabled: false }]) assert.throws(() => normalizeLoginRateLimit(value), RangeError)
  assert.deepEqual(normalizeLoginRateLimit({ maxAttempts: 1, windowSeconds: 10 }), { maxAttempts: 1, windowSeconds: 10 })
  assert.deepEqual(normalizeLoginRateLimit({ maxAttempts: 100, windowSeconds: 3600 }), { maxAttempts: 100, windowSeconds: 3600 })
})

test('Rolling windows persist across object recreation, expire at the boundary and reject without extending the block', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const { state, alarms } = sqlState(database)
  let limiter = new LoginRateLimiter(state as never)
  assert.deepEqual(await decision(limiter), { allowed: true, retryAfter: 0 })
  now += 1000
  assert.deepEqual(await decision(limiter), { allowed: true, retryAfter: 0 })
  limiter = new LoginRateLimiter(state as never)
  now += 500
  const alarmCount = alarms.length
  assert.deepEqual(await decision(limiter), { allowed: false, retryAfter: 9 })
  now = 999_000
  assert.deepEqual(await decision(limiter), { allowed: false, retryAfter: 9 }, 'A backwards clock cannot reset accepted attempts.')
  assert.equal(alarms.length, alarmCount)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 2)
  now = 1_010_000
  assert.deepEqual(await decision(limiter), { allowed: true, retryAfter: 0 })
  assert.deepEqual(await decision(limiter), { allowed: false, retryAfter: 1 })
})

test('Concurrent object requests cannot exceed the accepted attempt budget', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  t.mock.method(Date, 'now', () => 1_000_000)
  const { state } = sqlState(database)
  const limiter = new LoginRateLimiter(state as never)
  const decisions = await Promise.all(Array.from({ length: 12 }, () => decision(limiter, { maxAttempts: 3, windowSeconds: 10 })))
  assert.equal(decisions.filter(item => item.allowed).length, 3)
  assert.ok(decisions.filter(item => !item.allowed).every(item => item.retryAfter === 10))
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 3)
})

test('Check-only decisions preserve attempts, alarms and policy revisions while respecting an exhausted budget', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const { state, alarms } = sqlState(database)
  const limiter = new LoginRateLimiter(state as never)
  const policy = { maxAttempts: 2, windowSeconds: 10 }
  for (let index = 0; index < 12; index++) assert.deepEqual(await decision(limiter, policy, 0, false), { allowed: true, retryAfter: 0 })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 0)
  assert.equal(alarms.length, 0)
  assert.equal((await decision(limiter, policy)).allowed, true, 'Legacy two-field requests still consume an attempt.')
  const firstAlarmCount = alarms.length
  for (let index = 0; index < 12; index++) assert.equal((await decision(limiter, policy, 0, false)).allowed, true)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 1)
  assert.equal(alarms.length, firstAlarmCount)
  assert.equal((await decision(limiter, policy, 0, true)).allowed, true)
  const exhaustedAlarmCount = alarms.length
  assert.deepEqual(await decision(limiter, policy, 0, false), { allowed: false, retryAfter: 10 })
  const widened = { maxAttempts: 3, windowSeconds: 10 }
  assert.equal((await decision(limiter, widened, 1, false)).allowed, true)
  assert.equal((await decision(limiter, { maxAttempts: 100, windowSeconds: 10 }, 0, false)).allowed, true)
  assert.equal(database.prepare('SELECT version FROM login_rate_limit_policy WHERE id = 1').get()?.version, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 2)
  assert.equal(alarms.length, exhaustedAlarmCount)
  assert.equal((await decision(limiter, widened, 1)).allowed, true)
  assert.deepEqual(await decision(limiter, { maxAttempts: 100, windowSeconds: 10 }, 0, false), { allowed: false, retryAfter: 10 })
  now += 10_000
  const finalAlarmCount = alarms.length
  assert.deepEqual(await decision(limiter, widened, 1, false), { allowed: true, retryAfter: 0 })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 3, 'Check-only access retains history for later policy widening.')
  assert.equal(alarms.length, finalAlarmCount)
})

test('Policy tightening keeps historical attempts, uses the necessary expiry and never rolls back to a stale revision', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const { state } = sqlState(database)
  const limiter = new LoginRateLimiter(state as never)
  const original = { maxAttempts: 3, windowSeconds: 10 }
  for (let index = 0; index < 3; index++) { now = 1_000_000 + index * 1000; assert.equal((await decision(limiter, original)).allowed, true) }
  now = 1_003_000
  assert.deepEqual(await decision(limiter, { maxAttempts: 1, windowSeconds: 10 }, 1), { allowed: false, retryAfter: 9 })
  assert.deepEqual(await decision(limiter, { maxAttempts: 100, windowSeconds: 10 }, 0), { allowed: false, retryAfter: 9 })
  const conflicting = await limiter.fetch(checkRequest({ maxAttempts: 100, windowSeconds: 10 }, 1))
  assert.equal(conflicting.status, 503)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 3)
  now = 1_012_000
  assert.equal((await decision(limiter, { maxAttempts: 1, windowSeconds: 10 }, 1)).allowed, true)
})

test('Expanding a window recounts retained attempts and alarms preserve the latest policy', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const { state } = sqlState(database)
  const limiter = new LoginRateLimiter(state as never)
  assert.equal((await decision(limiter, { maxAttempts: 1, windowSeconds: 10 })).allowed, true)
  now += 11_000
  assert.deepEqual(await decision(limiter, { maxAttempts: 1, windowSeconds: 60 }, 1), { allowed: false, retryAfter: 49 })
  assert.equal((await decision(limiter, { maxAttempts: 2, windowSeconds: 60 }, 2)).allowed, true)
  now = 1_000_000 + 3_600_000
  await limiter.alarm()
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 1)
  assert.equal(database.prepare('SELECT version FROM login_rate_limit_policy WHERE id = 1').get()?.version, 2)
  now += 11_000
  await limiter.alarm()
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 0)
  assert.equal(database.prepare('SELECT version FROM login_rate_limit_policy WHERE id = 1').get()?.version, 2)
})

test('Invalid internal requests and storage failures deny safely without consuming valid attempts', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  t.mock.method(Date, 'now', () => 1_000_000)
  const { state } = sqlState(database)
  const limiter = new LoginRateLimiter(state as never)
  for (const request of [new Request('https://wrong.internal/check', { method: 'POST', ...{ headers: { 'Content-Type': 'application/json' }, body: '{}' } }), new Request('https://login-rate-limit.internal/check'), new Request('https://login-rate-limit.internal/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: { maxAttempts: 10, windowSeconds: 60 }, version: 0, bypass: true }) }), new Request('https://login-rate-limit.internal/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) })]) {
    const response = await limiter.fetch(request)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.equal((await response.json()).error.code, 'AUTH_RATE_LIMIT_UNAVAILABLE')
  }
  for (const fields of [{ consume: 'false' }, { consume: null }, { consume: 0 }, { consume: [] }, { consume: false, bypass: true }]) {
    const response = await limiter.fetch(new Request('https://login-rate-limit.internal/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: { maxAttempts: 10, windowSeconds: 60 }, version: 0, ...fields }) }))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'AUTH_RATE_LIMIT_UNAVAILABLE')
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 0)
  state.storage.sql.exec = () => { throw new Error('SQL unavailable') }
  assert.equal((await limiter.fetch(checkRequest())).status, 503)
  const alarmDatabase = new DatabaseSync(':memory:')
  t.after(() => alarmDatabase.close())
  const alarmState = sqlState(alarmDatabase).state
  alarmState.storage.setAlarm = async () => { throw new Error('Alarm unavailable') }
  const alarmLimiter = new LoginRateLimiter(alarmState as never)
  assert.equal((await alarmLimiter.fetch(checkRequest({ maxAttempts: 1, windowSeconds: 10 }))).status, 503)
  assert.equal(alarmDatabase.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 1)
  assert.deepEqual(await decision(alarmLimiter, { maxAttempts: 1, windowSeconds: 10 }), { allowed: false, retryAfter: 10 })
})

function namespaceWith(run: (request: Request) => Promise<Response>) {
  const names: string[] = []
  const namespace = {
    idFromName(name: string) { names.push(name); return name },
    get() { return { fetch: run } },
  }
  return { namespace, names }
}

test('Credential checks and consuming login attempts use one actor and reject check-only access when it is blocked', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  t.mock.method(Date, 'now', () => 1_000_000)
  const limiter = new LoginRateLimiter(sqlState(database).state as never)
  const { namespace, names } = namespaceWith(request => limiter.fetch(request))
  const request = new Request('http://127.0.0.1/api/config', { headers: { Authorization: 'Bearer verified-admin' } })
  const policy = { maxAttempts: 2, windowSeconds: 10 }
  for (let index = 0; index < 12; index++) await enforceLoginRateLimit(request, namespace as never, policy, 0, 'login', true, false)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 0)
  for (let index = 0; index < 2; index++) await enforceLoginRateLimit(request, namespace as never, policy, 0, 'login', true)
  await assert.rejects(enforceLoginRateLimit(request, namespace as never, policy, 0, 'login', true, false), error => error instanceof LoginRateLimitError && error.status === 429 && error.retryAfter === 10)
  assert.equal(new Set(names).size, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_rate_limit_attempts').get()?.count, 2)
})

test('Public callers cannot rotate rate-limit keys through credentials or spoofed forwarding headers', async () => {
  const { namespace, names } = namespaceWith(async () => Response.json({ allowed: true, retryAfter: 0 }))
  for (const headers of [{ 'X-Forwarded-For': '192.0.2.1', Authorization: 'Bearer first' }, { 'X-Forwarded-For': '198.51.100.2', 'CF-Connecting-IP': '203.0.113.5', Authorization: 'Bearer second' }]) {
    const request = new Request('https://storage.example/api/session', { headers })
    await enforceLoginRateLimit(request, namespace as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', false)
  }
  assert.equal(names[0], names[1], 'Untrusted requests without edge runtime data share the unknown actor key.')
  await enforceLoginRateLimit(new Request('http://127.0.0.1/api/session', { headers: { 'CF-Connecting-IP': '192.0.2.1' } }), namespace as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', true)
  await enforceLoginRateLimit(new Request('http://127.0.0.1/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.2' } }), namespace as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', true)
  assert.equal(names[2], names[3], 'Local callers share one key regardless of supplied IP headers.')
  await enforceLoginRateLimit(new Request('http://127.0.0.1/api/setup'), namespace as never, { maxAttempts: 3, windowSeconds: 60 }, 0, 'setup', true)
  assert.notEqual(names[3], names[4], 'Setup and login have independent counters.')
})

test('Trusted edge IPs are normalized while missing bindings, invalid decisions and unavailable storage fail closed', async () => {
  const { namespace, names } = namespaceWith(async () => Response.json({ allowed: true, retryAfter: 0 }))
  for (const ip of ['2001:DB8:0:0:0:0:0:1', '2001:db8::1']) {
    const request = new Request('https://storage.example/api/session', { headers: { 'CF-Connecting-IP': ip } })
    Object.defineProperty(request, 'cf', { value: { colo: 'HKG' } })
    await enforceLoginRateLimit(request, namespace as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', false)
  }
  assert.equal(names[0], names[1])
  const request = new Request('http://127.0.0.1/api/session')
  const unavailable = (error: unknown) => error instanceof LoginRateLimitError && error.status === 503 && error.code === 'AUTH_RATE_LIMIT_UNAVAILABLE' && error.retryAfter === 60
  await assert.rejects(enforceLoginRateLimit(request, undefined, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', true), unavailable)
  for (const run of [async () => Response.json({ allowed: true, retryAfter: 1 }), async () => Response.json({ allowed: false, retryAfter: 0 }), async () => Response.json({ allowed: true, retryAfter: 0, bypass: true }), async () => new Response('x'.repeat(1025)), async () => new Response('{}', { status: 500 }), async () => { throw new Error('Binding unavailable') }]) {
    const invalid = namespaceWith(run).namespace
    await assert.rejects(enforceLoginRateLimit(request, invalid as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', true), unavailable)
  }
  const limited = namespaceWith(async () => Response.json({ allowed: false, retryAfter: 7 })).namespace
  await assert.rejects(enforceLoginRateLimit(request, limited as never, { maxAttempts: 10, windowSeconds: 60 }, 0, 'login', true), error => error instanceof LoginRateLimitError && error.status === 429 && error.code === 'LOGIN_RATE_LIMITED' && error.retryAfter === 7)
})
