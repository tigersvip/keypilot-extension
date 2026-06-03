function $(selector) {
  return document.querySelector(selector);
}

function setStatus(message, tone = '') {
  const result = $('#result');
  if (!result) return;
  result.className = tone ? `result ${tone}` : 'result';
  result.textContent = message;
}

function readForm(form) {
  const data = new FormData(form);
  return {
    username: String(data.get('username') || data.get('email') || data.get('login') || ''),
    password: String(data.get('password') || '')
  };
}

function attachBasicSubmit() {
  const form = $('#login-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm(form);
    setStatus(`已提交：${values.username || '空用户名'} / 密码长度 ${values.password.length}`, 'success');
  });
}

function attachSteppedLogin() {
  const form = $('#stepped-form');
  if (!form) return;

  const usernameStep = $('#username-step');
  const passwordStep = $('#password-step');
  const nextButton = $('#next-button');

  nextButton?.addEventListener('click', () => {
    const username = $('#step-username')?.value.trim();
    if (!username) {
      setStatus('请先输入用户名。', 'danger');
      return;
    }

    setStatus('用户名步骤已通过，正在显示密码框。');
    window.setTimeout(() => {
      usernameStep?.classList.add('hidden');
      passwordStep?.classList.remove('hidden');
      $('#step-password')?.focus();
    }, 180);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = $('#step-username')?.value || '';
    const password = $('#step-password')?.value || '';
    setStatus(`分步登录已提交：${username} / 密码长度 ${password.length}`, 'success');
  });
}

function attachUnsafeLogin() {
  const form = $('#unsafe-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm(form);
    setStatus(`页面收到提交：${values.username || '空用户名'} / 密码长度 ${values.password.length}`, 'danger');
  });
}

function attachSaveCapture() {
  const form = $('#save-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm(form);
    setStatus(`已模拟登录成功：${values.username || '空用户名'}。现在打开 KeyPilot，应看到保存提示。`, 'success');
  });
}

attachBasicSubmit();
attachSteppedLogin();
attachUnsafeLogin();
attachSaveCapture();
