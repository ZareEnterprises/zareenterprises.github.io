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

async function emnInit(){
  await emnLoadSession();
  emnInjectAuthLink();
}
