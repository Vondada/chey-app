// The fixture's own script. It tries everything the observer must stop: submitting a form,
// leaving the page, sending data after load, and reaching loopback addresses. __PORT__ is the
// fixture server's port, filled in when it is served.
document.getElementById('docs-button').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!open));
  document.getElementById('docs-menu').hidden = open;
  fetch('/late-post', { method: 'POST', body: 'clicked' }).catch(() => {});
  setTimeout(() => { location.href = '/elsewhere'; }, 100);
});
document.getElementById('q').addEventListener('focus', () => {
  document.getElementById('suggestions').hidden = false;
});
setTimeout(() => {
  const form = document.getElementById('signin');
  form.submit();
  form.requestSubmit();
}, 200);
console.error('fixture console error');
new Image().src = 'http://127.0.0.1:__PORT__/leak-ip';
fetch('http://localhost:__PORT__/leak-name').catch(() => {});
fetch('http://[::1]:__PORT__/leak-v6').catch(() => {});
try { new WebSocket('ws://127.0.0.1:__PORT__/leak-ws'); } catch (_) { /* refused */ }
const frame = document.createElement('iframe');
frame.src = 'http://127.0.0.1:__PORT__/leak-frame';
frame.width = '1';
frame.height = '1';
document.body.appendChild(frame);
