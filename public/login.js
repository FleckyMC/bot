const e = new URLSearchParams(location.search).get('e');
const box = document.getElementById('err');
if (e === 'rate') box.textContent = 'Zu viele Versuche. Bitte in 10 Minuten erneut probieren.';
else if (e) box.textContent = 'Benutzername oder Passwort falsch.';
