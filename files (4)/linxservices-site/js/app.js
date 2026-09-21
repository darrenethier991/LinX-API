/* ============================================================
   LinX — linxservices.ca · Shared JS (app.js)
   Contractor data is the single source of truth here, used by
   find-contractors.html and contractor-profile.html.
   Demo dataset carried over from the LinX app mockups — replace
   with a live API call when the backend endpoint is ready.
   ============================================================ */

const CONTRACTORS = [
  { id: 'mike-t',   name: 'Mike T.',   initials: 'MT', trade: 'Roofing',            city: 'Barrie',      rating: 4.9, reviews: 87,  rate: 95,  tags: ['Licensed', 'Insured', 'Free Estimate'],  bio: '12+ years in residential roofing across Barrie and Simcoe County. Specializing in asphalt shingle, metal, and flat roofs.', online: true,  jobs: 203, verified: true, since: 2022, resp: '1–2 hours',  area: ['Barrie', 'Innisfil', 'Orillia', 'Angus', 'Collingwood'] },
  { id: 'carlos-r', name: 'Carlos R.', initials: 'CR', trade: 'Landscaping',        city: 'Orillia',     rating: 4.7, reviews: 63,  rate: 75,  tags: ['Insured', 'Free Estimate'],              bio: 'Award-winning landscape designer with 8 years of experience creating beautiful outdoor spaces in Simcoe County.',          online: true,  jobs: 94,  verified: true, since: 2023, resp: '2–4 hours',  area: ['Orillia', 'Barrie', 'Midland'] },
  { id: 'jake-w',   name: 'Jake W.',   initials: 'JW', trade: 'Carpentry',          city: 'Barrie',      rating: 4.8, reviews: 44,  rate: 85,  tags: ['Licensed', 'Insured'],                   bio: 'Custom carpentry and fencing specialist. Decks, fences, framing, and finishing work done right the first time.',           online: false, jobs: 78,  verified: true, since: 2023, resp: 'Same day',   area: ['Barrie', 'Innisfil', 'Angus'] },
  { id: 'tom-b',    name: 'Tom B.',    initials: 'TB', trade: 'Plumbing',           city: 'Innisfil',    rating: 4.6, reviews: 112, rate: 110, tags: ['Licensed', 'Insured', 'Emergency'],      bio: 'Licensed plumber serving all of Simcoe County. Emergency service available. 15+ years residential and commercial experience.', online: false, jobs: 321, verified: true, since: 2022, resp: '< 1 hour',   area: ['Innisfil', 'Barrie', 'Alcona', 'All of Simcoe Co.'] },
  { id: 'anna-k',   name: 'Anna K.',   initials: 'AK', trade: 'Painting',           city: 'Collingwood', rating: 4.9, reviews: 35,  rate: 65,  tags: ['Insured', 'Interior', 'Exterior'],       bio: 'Professional painter with an eye for detail. Interior, exterior, cabinets, and feature walls. Premium finishes every time.',   online: true,  jobs: 47,  verified: true, since: 2024, resp: '2–4 hours',  area: ['Collingwood', 'Wasaga Beach', 'Barrie'] },
  { id: 'derek-m',  name: 'Derek M.',  initials: 'DM', trade: 'Electrical',         city: 'Barrie',      rating: 4.8, reviews: 58,  rate: 120, tags: ['Licensed', 'Insured', '24/7'],           bio: 'Certified master electrician for residential and commercial projects. Panel upgrades, EV chargers, renovations.',           online: false, jobs: 188, verified: true, since: 2022, resp: '1–2 hours',  area: ['Barrie', 'Innisfil', 'Orillia'] },
  { id: 'pat-l',    name: 'Pat L.',    initials: 'PL', trade: 'HVAC',               city: 'Midland',     rating: 4.5, reviews: 29,  rate: 100, tags: ['Certified', 'Insured', 'All Brands'],    bio: 'HVAC technician covering heating, cooling, and ventilation. Installs, repairs, and annual tune-ups.',                       online: false, jobs: 52,  verified: true, since: 2024, resp: 'Same day',   area: ['Midland', 'Orillia', 'Penetanguishene'] },
  { id: 'kevin-s',  name: 'Kevin S.',  initials: 'KS', trade: 'General Contractor', city: 'Barrie',      rating: 4.7, reviews: 74,  rate: 80,  tags: ['Licensed', 'Full Reno', 'Insured'],      bio: 'Full-service general contractor handling kitchens, bathrooms, basements, and additions. Turnkey renovations done right.',   online: true,  jobs: 142, verified: true, since: 2022, resp: '1–2 hours',  area: ['Barrie', 'Innisfil', 'All of Simcoe Co.'] },
];

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
