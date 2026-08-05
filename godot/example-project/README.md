# Example project

The round-trip and integration harnesses (`roundtrip.gd`, `integration.gd`)
run against this project with the addon **copied in at test time**:

```bash
cp -r ../addon/lunar_terrain addons/
```

The copy is deliberately not committed — `godot/addon/lunar_terrain/` is the
single source of truth, and a second committed copy would drift. The test
suites (`tests/godot-*.test.ts`) perform the copy themselves.
