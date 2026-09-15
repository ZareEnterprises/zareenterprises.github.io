// Shared Supabase client + optional sign-in for EMN pages.
// Own Supabase project, separate from AMBRA's — separate URL, separate anon
// key, separate database. Never mix these two.
//
// Pages that use this must load the Supabase JS library first:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/assets/js/emn-auth.js?v={{ site.time | date: '%s' }}"></script>
// (the ?v= cache-busts it the same way emn.css already does — without it,
// browsers can keep serving a stale cached copy after this file changes.)
//
// There's no self-signup anywhere — the only way to get an account is being
// invited by an Admin. Sign-in itself is optional everywhere: this file
// never redirects anyone, it just exposes `emnSession` / `emnStudentProfile`
// (both null when signed out) after `emnInit()` resolves.

const EMN_SUPABASE_URL = 'https://gpoddvcrsdkpgfmyniqu.supabase.co';
const EMN_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdwb2RkdmNyc2RrcGdmbXluaXF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0Nzc3MzksImV4cCI6MjEwNTA1MzczOX0.N9XvN4xdln5GFlTcpv3nE3iThH7Jfoym23HPp97_fxc';

const emnSupabase = window.supabase.createClient(EMN_SUPABASE_URL, EMN_SUPABASE_ANON_KEY);

let emnSession = null;
let emnStudentProfile = null; // row from `students` — null until signed in AND loaded

async function emnLoadSession(){
  const { data } = await emnSupabase.auth.getSession();
  emnSession = data.session || null;
  emnStudentProfile = null;
  if(emnSession){
    const { data: profile } = await emnSupabase.from('students').select('*').eq('id', emnSession.user.id).maybeSingle();
    emnStudentProfile = profile || null;
  }
  return emnSession;
}

emnSupabase.auth.onAuthStateChange((_event, session) => {
  emnSession = session;
  if(!session) emnStudentProfile = null;
});

// Drops a "Log in" (or, once signed in, the person's name) link into the
// shared `.emn-nav` header — only present on the marketing pages (Home,
// Practice Lab, Feedback), not the `.emn-tool` pages.
function emnInjectAuthLink(){
  const nav = document.querySelector('.emn-nav');
  if(!nav) return;

  const authLink = document.createElement('a');
  authLink.className = 'emn-nav__link';
  if(emnSession){
    authLink.classList.add('emn-nav__link--user');
    authLink.href = '#';
    authLink.textContent = emnStudentProfile?.full_name || emnSession.user.email;
    authLink.onclick = async (e) => {
      e.preventDefault();
      if(confirm('Log out?')){ await emnSupabase.auth.signOut(); location.reload(); }
    };
  } else {
    authLink.href = '/emn-login';
    authLink.textContent = 'Log in';
  }
  nav.appendChild(authLink);
}

// "Administrar" dropdown (Usuarios / Actividad) — Admin and Professor only.
// Students never see this tab at all. Built by hand (not the shared
// caret-toggle script those other dropdowns use) because it's injected
// after that script has already wired up whatever `.emn-nav__item`s
// existed at page load.
function emnInjectAdminMenu(){
  if(!emnStudentProfile || (emnStudentProfile.role !== 'admin' && emnStudentProfile.role !== 'professor')) return;
  const nav = document.querySelector('.emn-nav');
  if(!nav) return;

  const item = document.createElement('div');
  item.className = 'emn-nav__item';
  item.innerHTML = `
    <a href="#" class="emn-nav__link">Administrar</a>
    <button class="emn-nav__caret" aria-label="Abrir submenú de Administrar" aria-expanded="false">&#9662;</button>
    <div class="emn-nav__dropdown">
      <a href="https://zareenterprises.github.io/usuarios" class="emn-nav__dropdown-item">Usuarios</a>
      <a href="https://zareenterprises.github.io/actividad" class="emn-nav__dropdown-item">Actividad</a>
    </div>
  `;
  nav.appendChild(item);

  const caret = item.querySelector('.emn-nav__caret');
  const label = item.querySelector('.emn-nav__link');
  const toggle = (e) => {
    e.preventDefault();
    const isOpen = item.classList.contains('is-open');
    document.querySelectorAll('.emn-nav__item').forEach((i) => i.classList.remove('is-open'));
    item.classList.toggle('is-open', !isOpen);
    caret.setAttribute('aria-expanded', String(!isOpen));
  };
  caret.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  document.addEventListener('click', (e) => {
    if(!item.contains(e.target)) item.classList.remove('is-open');
  });
}

async function emnInit(){
  await emnLoadSession();
  emnInjectAdminMenu();
  emnInjectAuthLink();
}

/* ============================= PRACTICE TIME HEARTBEAT =============================
   Used by sight-melody.html and interview-prep.html only. Call
   emnStartHeartbeat('sight-melody' | 'interview-prep') once, after emnInit()
   resolves and only if emnSession exists — it no-ops silently for signed-out
   visitors, which is what makes sign-in optional there too: the tool works
   the same either way, it just doesn't log time when nobody's signed in.

   "Active" = the tab is visible AND the student has interacted (click, key,
   pointer move, touch) within the last INACTIVITY_LIMIT — so time isn't
   still counting while they've tabbed away or stepped away from the
   keyboard. Ticks every HEARTBEAT_SECONDS and adds that many seconds to
   today's row for this student+tool, creating it on the first tick of the
   day (upsert with an additive read-then-write, not a raw insert). */
const HEARTBEAT_SECONDS = 30;
const INACTIVITY_LIMIT_MS = 60000;

function emnStartHeartbeat(tool){
  if(!emnSession) return;
  let lastInteraction = Date.now();
  ['click','keydown','pointermove','touchstart'].forEach(evt => {
    document.addEventListener(evt, () => { lastInteraction = Date.now(); }, { passive: true });
  });

  setInterval(async () => {
    if(document.visibilityState !== 'visible') return;
    if(Date.now() - lastInteraction > INACTIVITY_LIMIT_MS) return;

    const today = new Date();
    const activityDate = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

    const { data: existing } = await emnSupabase
      .from('practice_activity')
      .select('id, seconds')
      .eq('student_id', emnSession.user.id)
      .eq('tool', tool)
      .eq('activity_date', activityDate)
      .maybeSingle();

    if(existing){
      await emnSupabase.from('practice_activity').update({
        seconds: existing.seconds + HEARTBEAT_SECONDS,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
    } else {
      await emnSupabase.from('practice_activity').insert({
        student_id: emnSession.user.id, tool, activity_date: activityDate, seconds: HEARTBEAT_SECONDS
      });
    }
  }, HEARTBEAT_SECONDS * 1000);
}
