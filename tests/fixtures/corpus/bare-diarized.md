Ada: The cache invalidation bug only shows up on the second deploy.
Grace: Because the first deploy warms the cache with stale keys.
Ada: Right, so we should version the cache keys by build hash.
