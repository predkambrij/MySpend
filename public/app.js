const views = {
  loading: document.querySelector('#loading-view'),
  login: document.querySelector('#login-view'),
  app: document.querySelector('#app-view'),
};

const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginError = document.querySelector('#login-error');
const passwordInput = document.querySelector('#password');
const logoutButton = document.querySelector('#logout-button');
let csrfToken = '';

function showView(name) {
  for (const [viewName, view] of Object.entries(views)) view.hidden = viewName !== name;
  if (name === 'login') passwordInput.focus();
}

async function checkSession() {
  try {
    const response = await fetch('api/session', { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const session = await response.json();
      csrfToken = session.csrfToken;
      showView('app');
    } else {
      csrfToken = '';
      showView('login');
    }
  } catch {
    loginError.textContent = 'Unable to connect to the server.';
    loginError.hidden = false;
    showView('login');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  loginError.hidden = true;

  try {
    const response = await fetch('api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });

    if (!response.ok) {
      const message = response.status === 429
        ? 'Too many attempts. Please try again later.'
        : 'The password is incorrect.';
      throw new Error(message);
    }

    const session = await response.json();
    csrfToken = session.csrfToken;
    loginForm.reset();
    showView('app');
  } catch (error) {
    loginError.textContent = error.message === 'Failed to fetch' ? 'Unable to connect to the server.' : error.message;
    loginError.hidden = false;
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in';
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const response = await fetch('api/session', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (response.ok || response.status === 401) {
      csrfToken = '';
      showView('login');
    }
  } finally {
    logoutButton.disabled = false;
  }
});

checkSession();
