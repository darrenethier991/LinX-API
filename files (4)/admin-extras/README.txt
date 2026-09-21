LinX Admin — deploy extras
==========================
Place these two files at the ROOT of the admin Pages project,
next to index.html (rename admin-dashboard_html.html -> index.html).

- robots.txt  : tells crawlers to stay out
- _headers    : adds noindex + security headers at the edge

These are courtesy layers only. The actual lock is Cloudflare
Access (Zero Trust) on www.wwwlinxservices.com — see deploy steps.
