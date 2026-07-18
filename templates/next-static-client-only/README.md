# App

A client-side web app built with VibeHard. Next.js (static export) + TypeScript + Tailwind CSS.
All data persists in the browser (localStorage) — there is no backend and no server-side state.

## Run it

```sh
npm ci          # install pinned dependencies
npm run dev     # develop at http://localhost:3000
npm run build   # export the static site to out/
npm start       # serve out/ (reads PORT, default 8080)
```

Or with the container:

```sh
docker build -t app . && docker run -p 8080:8080 app
```

## Environment variables

None. The app is fully client-side.
