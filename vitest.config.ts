export default {
  test: {
    testTimeout: 30_000, // PGlite boot + password hashing can be slow on first run
    hookTimeout: 60_000,
  },
};