# Captured architect-LLM data models — the backend regression corpus

Each `*.json` here is a **real** `dataModel` a live architect run emitted (not a hand-authored shape).
`corpus.test.ts` runs every one through `coerceDataModel → generateBackend → migrate gate → RLS-
enforcement gate` and asserts the generated backend applies clean **and proves tenant isolation**. The
corpus grows whenever a live run surfaces a new shape, so the suite improves proactively instead of only
after a shape breaks production.

## Capturing a new model

After any real build, `generateBackend` persists the coerced model to `<workspace>/.vibehard/
datamodel.json`. To add it to the corpus:

```sh
cp <workspace>/.vibehard/datamodel.json fixtures/architect-models/<descriptive-name>.json
```

Prefer models with shapes not already covered (different ownership patterns, deeper FK chains, unusual
access mixes). A `_source` note describing the prompt/provider/date is appreciated but optional — the
loader ignores any key starting with `_`.
