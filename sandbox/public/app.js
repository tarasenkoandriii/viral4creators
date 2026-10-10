const $ = (id) => document.getElementById(id);
function renderLogin() { const active = sessionStorage.getItem('sandbox-demo-session') === 'active'; $('cabinet').hidden = !active; $('login-form').hidden = active; }
$('login-form').addEventListener('submit', e => { e.preventDefault(); const data = new FormData(e.target); if (data.get('email') === 'demo@example.test' && data.get('password') === 'SandboxDemo123!') { sessionStorage.setItem('sandbox-demo-session', 'active'); $('login-status').textContent = 'Вы вошли в демонстрационный кабинет'; renderLogin(); } else { $('login-status').textContent = 'Неверный email или пароль'; } });
$('logout').addEventListener('click', () => { sessionStorage.removeItem('sandbox-demo-session'); $('login-status').textContent = 'Вы вышли'; renderLogin(); });
$('save-settings').addEventListener('click', () => { sessionStorage.setItem('sandbox-demo-notifications', $('notifications').value); $('settings-status').textContent = 'Настройки сохранены'; });
$('notifications').value = sessionStorage.getItem('sandbox-demo-notifications') || 'daily';
$('request-form').addEventListener('submit', e => { e.preventDefault(); $('form-status').textContent = 'Тестовая заявка принята. Отправка отключена.'; e.target.reset(); });
let step = 1;
function renderStep() { $('tutorial-step').textContent = ['Шаг 1 из 3: выберите тему', 'Шаг 2 из 3: проверьте поля формы', 'Шаг 3 из 3: обучение завершено'][step - 1]; $('next-step').disabled = step === 3; }
$('next-step').addEventListener('click', () => { step = Math.min(3, step + 1); renderStep(); });
$('reset-tutorial').addEventListener('click', () => { step = 1; renderStep(); });
renderLogin();
