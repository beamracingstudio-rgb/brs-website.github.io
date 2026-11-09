# Beam Racing Studio — website v2

Static site (host anywhere: GitHub Pages, Netlify, Cloudflare Pages) + one Google Apps Script backend (`Code.gs`) that lives in your league spreadsheet.

## What it does
- **Points** — driver and team standings read live from your sheet (Racer Registration + Leaderboard). Team points = sum of members' points.
- **Log in / Sign up** — Google sign-in. First login creates the account, then the driver sets name, Discord, number, team.
- **Race sign-ups** — drivers register from each race card. Free races confirm instantly; paid races give a Pay button, then the driver enters a payment reference.
- **Admin panel** (Admin button, only for admins) — add/edit/delete races, set prices (0 = free), capacity, open/closed/draft; see and change every sign-up (Pending payment → Payment submitted → Paid); add drivers by hand; add videos (YouTube/Vimeo play in-page) and pictures (paste a link or upload); set the default payment link; add/remove admins; check which sheet columns the site is reading.

Nothing in your existing tabs is ever written to. The site creates its own tabs: `Site Users`, `Site Events`, `Site Signups`, `Site Media`, `Site Admins`, `Site Config`.

## Setup (about 15 minutes)
1. **Backend code.** Open your spreadsheet → Extensions → Apps Script → paste all of `Code.gs` over the default file.
2. **Google sign-in key.** Google Cloud Console → create a project → APIs & Services → OAuth consent screen (External; add your email; publish to "In production" so anyone can log in) → Credentials → Create credentials → OAuth client ID → *Web application*. Under **Authorized JavaScript origins** add your site address (e.g. `https://yourname.github.io`) and `http://localhost` for testing. Copy the Client ID.
3. In `Code.gs`, replace `GOOGLE_CLIENT_ID` with it. Select the `setup` function → Run → approve the permissions. This creates the `Site …` tabs and makes **the Google account you ran it with the first admin**.
4. **Deploy** → New deployment → type *Web app* → Execute as **Me**, Who has access **Anyone** → Deploy. Copy the Web app URL (ends in `/exec`).
5. In `config.js` set `apiUrl` (that URL) and `googleClientId`. Upload the folder to your host.
6. Log in on the site with your admin Google account → click **Admin**.
7. Admin → **Payments**: paste a payment link template, e.g. `https://paypal.me/YourName/{amount}{currency}`. Now every priced race gets a working Pay button, and changing a price updates it.
8. Admin → **Data connection**: confirm it found your Leaderboard points column. If not, type the exact header names there.

When you change `Code.gs` later: Deploy → Manage deployments → edit → New version.

## Things to know
- **Discord login is not included.** It needs a secure server for the OAuth secret; Google sign-in works with this setup and nothing secret sits in the page.
- **Payments are confirmed by hand.** The site never touches card details. The driver pays via your link and submits a reference; you set the entry to Paid. (Automatic confirmation needs a payment provider webhook.)
- **Driver names must match** the Racer Registration sheet (case-insensitive) for a driver's own stats to show in their account.
- Public data refreshes about once a minute. Emails are never sent to the public site.
- Uploaded pictures are saved to a Drive folder called "BRS Website Uploads" (shared by link).
