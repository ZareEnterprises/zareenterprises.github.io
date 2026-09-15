// Shared Supabase client + optional-session helpers for every EMN page.
// This is its OWN Supabase project — separate URL, separate anon key,
// separate database — from the one AMBRA's /palante and /panel use. Never
// mix these two: swapping in AMBRA's credentials here (or vice versa) would
// point this at the wrong project's users table entirely.
//
// Every page that includes this file must first load the Supabase JS
// library itself:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/assets/js/emn-auth.js"></script>
//
// Sign-in is OPTIONAL everywhere in EMN — this file never redirects anyone.
// It just exposes `emnSession` / `emnStudentProfile` (both null when signed
// out) after `emnInit()` resolves, for pages to use however they need to.

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

// Drops a "Log in"/name link (and, for admins & professors, an "Alumnos"
// link) into the shared `.emn-nav` header — only present on the marketing
// pages (Home, Practice Lab, Feedback), not the `.emn-tool` pages, which
// have a different topbar and don't need this.
function emnInjectNavLinks(){
  const nav = document.querySelector('.emn-nav');
  if(!nav) return;

  const authLink = document.createElement('a');
  authLink.className = 'emn-nav__link';
  if(emnSession){
    authLink.href = '#';
    authLink.textContent = emnStudentProfile?.full_name || emnSession.user.email;
    authLink.onclick = async (e) => {
      e.preventDefault();
      if(confirm('Log out?')){ await emnSupabase.auth.signOut(); location.reload(); }
    };
  } else {
    authLink.href = '/emn-login/';
    authLink.textContent = 'Log in';
  }
  nav.appendChild(authLink);

  if(emnStudentProfile && (emnStudentProfile.role === 'admin' || emnStudentProfile.role === 'professor')){
    const alumnosLink = document.createElement('a');
    alumnosLink.className = 'emn-nav__link';
    alumnosLink.href = '/alumnos/';
    alumnosLink.textContent = 'Alumnos';
    nav.appendChild(alumnosLink);
  }
}

async function emnInit(){
  await emnLoadSession();
  emnInjectNavLinks();
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
