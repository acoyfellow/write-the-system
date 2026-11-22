# Contributing

1. `npm install`, then `npm run check`. It needs no API key.
2. Keep changes small, and add a test in `test/` for new behavior.
3. A change to the benchmark needs a new receipt: commit first, then run `npm run bench`, and commit the receipt it writes to `bench/`. Say in the pull request what changed and what the numbers did.
4. Do not tune the benchmark data or the answer key to make a result look better.
