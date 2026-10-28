const e = new URLSearchParams(location.search).get('e');
const box = document.getElementById('err');
if (e === 'rate') box.textContent = 'Too many attempts. Please try again in 10 minutes.';
else if (e) box.textContent = 'Incorrect username or password.';
