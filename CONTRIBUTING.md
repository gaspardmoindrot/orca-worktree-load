# Contributing

Issues and pull requests are welcome.

- Run `npm run validate`, `npm test` and `npm run typecheck` before you open a pull request; CI runs the same three.
- Keep `src/model.ts`, `src/stop.ts` and `src/view.ts` free of I/O, so they stay testable with plain fixtures. Commands and signals go through `src/system.ts`.
- Anything that changes what Stop ends needs a test in `src/stop.test.ts`.
- If the panel changes, run `npm run shoot` and commit the new `assets/*.png`. Images only ever show `tools/sample-data.json`, never a real machine.
- Add a line to `CHANGELOG.md`, and say if the change asks for new Orca access.
