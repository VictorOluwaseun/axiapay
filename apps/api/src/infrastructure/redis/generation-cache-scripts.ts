/** Capture a fill generation atomically before PostgreSQL is read; missing/evicted fences receive new random identities. */
export const readScript = `
local epoch = redis.call('GET', KEYS[1])
if not epoch then epoch = ARGV[1]; redis.call('SET', KEYS[1], epoch) end
local generation = redis.call('HGET', KEYS[2], 'generation')
if not generation or redis.call('HGET', KEYS[2], 'epoch') ~= epoch then
  generation = ARGV[2]
  redis.call('HSET', KEYS[2], 'epoch', epoch, 'generation', generation)
  redis.call('PEXPIRE', KEYS[2], 120000)
  redis.call('DEL', KEYS[3])
end
return {epoch, generation, redis.call('GET', KEYS[3]) or ''}
`;

/** Publish only under the pre-read generation; invalidation, namespace reset or fence eviction rejects old readers. */
export const fillScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[4])
redis.call('PEXPIRE', KEYS[2], 120000)
return 1
`;

/** Invalidate a bounded batch atomically; absent entries also receive new fences for overlapping reads. */
export const invalidateScript = `
if ARGV[1] == 'all' then redis.call('SET', KEYS[1], ARGV[2]); return 1 end
local epoch = redis.call('GET', KEYS[1])
if not epoch then epoch = ARGV[2]; redis.call('SET', KEYS[1], epoch) end
for index = 2, #KEYS, 2 do
  redis.call('HSET', KEYS[index], 'epoch', epoch, 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[index], 120000)
  redis.call('DEL', KEYS[index + 1])
end
return 1
`;
