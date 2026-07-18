# App

A web app built with VibeHard. Next.js (App Router, standalone output) + TypeScript +
Tailwind CSS + Supabase (Postgres with Row-Level Security).

## Run it

```sh
npm ci          # install pinned dependencies
npm run dev     # develop at http://localhost:3000
npm run build   # production build (.next/standalone)
npm start       # serve (reads PORT, default 3000 locally)
```

Or with the container:

```sh
docker build -t app . && docker run -p 8080:8080 app
```

## Environment variables

See `.env.example` — Supabase URL and anon key (RLS-gated public values). The platform
injects real values at deploy; the service-role key never reaches the app.
