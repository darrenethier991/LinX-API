/* ============================================================
   LinX — linxservices.ca · Shared JS (app.js)
   Contractor data is the single source of truth here, used by
   find-contractors.html and contractor-profile.html.
   The demo dataset was removed — no fake listings or reviews.
   When real contractor data is available, populate this array
   from the live API instead of hardcoding entries here.
   ============================================================ */

const CONTRACTORS = [];

const TRADES = ['Plumbing', 'Roofing', 'Electrical', 'HVAC', 'Landscaping', 'Painting', 'Flooring', 'Masonry', 'Carpentry', 'General Contractor'];
const CITIES = ['Barrie', 'Orillia', 'Midland', 'Collingwood', 'Innisfil'];

/* ---------- Shared helpers ---------- */

function starString(rating) {
  const full = Math.floor(rating);
  return `<span class="stars">${'★'.repeat(full)}<span class="off">${'★'.repeat(5 - full)}</span></span>`;
}

function contractorCard(c) {
  return `
    <div class="card card--hover contractor-card">
      <div style="display:flex;align-items:flex-start;gap:1rem;">
        <div style="position:relative;">
          <div class="contractor-avatar">${c.initials}</div>
          ${c.online ? '<span class="online-dot" style="position:absolute;bottom:1px;right:1px;"></span>' : ''}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;">
            <span class="c-name">${c.name}</span>
            ${c.verified ? '<span class="tag tag--blue">✓ Verified</span>' : ''}
          </div>
          <div class="c-trade">${c.trade}</div>
          <div class="c-meta">📍 ${c.city}, ON</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div>${starString(c.rating)}</div>
          <div class="c-meta">${c.rating} · ${c.reviews} reviews</div>
        </div>
      </div>
      <p class="c-bio">${c.bio}</p>
      <div style="display:flex;flex-wrap:wrap;gap:.3rem;">
        ${c.tags.map(t => `<span class="tag">${t}</span>`).join('')}
      </div>
      <div class="c-stats-row" style="margin-top:.8rem;">
        <span><span class="c-rate">$${c.rate}</span>/hr avg</span>
        <span>${c.jobs} jobs completed</span>
        <span style="color:${c.online ? 'var(--green)' : 'var(--white-35)'};">${c.online ? '● Online' : 'Offline'}</span>
      </div>
      <div style="display:flex;gap:.5rem;">
        <a href="contractor-profile.html?id=${c.id}" class="btn btn--outline btn--sm" style="flex:1;">View Profile</a>
        <a href="post-job.html?trade=${encodeURIComponent(c.trade)}" class="btn btn--gold btn--sm" style="flex:1;">Request a Quote</a>
      </div>
    </div>`;
}

/* ---------- Topbar (mobile) + footer year ---------- */

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('topbar-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  document.querySelectorAll('.js-year').forEach(el => { el.textContent = new Date().getFullYear(); });
});
