Javi (Online-first, Multi-user) — Static HTML/CSS/JS + Supabase

What this is:
- A browser-based app (no server) that uses Supabase as the backend
- Email/password login (multi-user)
- Shared team workspace: any signed-in user can see/edit everything

1) Create your Supabase project
- supabase.com → New project

2) Create the database schema + security
- Open Supabase Dashboard → SQL Editor
- Paste/run: supabase_setup.sql (from this folder)

3) Configure the app
- Open config.js
- Paste your:
  - Project URL
  - anon public key
  (Supabase Dashboard → Settings → API)

4) Run locally (Windows)
- Install Node.js (LTS)
- In this folder:
  npx http-server -p 8080
- Open:
  http://localhost:8080

5) Deploy (so phones can use it)
- Any static host works (Netlify / Vercel static / Cloudflare Pages / GitHub Pages)
- IMPORTANT: If you deploy, update Supabase Auth → URL Configuration:
  - Site URL = your deployed URL
  - Add Redirect URLs as needed

Notes
- This is “Option A”: simplest shared workspace policies.
- If you later want roles (admin/member) or multiple workspaces, we add workspace tables + stricter RLS.

QR workflow
- Each gear item now has an optional `qr_code` value.
- In an event, use **Scan QR to reserve** to add gear quickly, and while event is ongoing use **Scan QR to return item**.
- Browser QR scanning uses `BarcodeDetector` + camera; if unavailable, you can paste the scanned code manually.

QR setup troubleshooting (Supabase)
- Error: `Could not find the 'qr_code' column of 'gear_items' in the schema cache`
  1) Open Supabase Dashboard → SQL Editor.
  2) Run this SQL in your project:

  alter table public.gear_items
    add column if not exists qr_code text default '';

  notify pgrst, 'reload schema';

  3) Refresh the app and try saving gear again.
- Why this happens: your project was created before the QR feature and is missing the new column.
