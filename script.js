// Year & simple language toggle (visual only)
document.getElementById('year').textContent = new Date().getFullYear();

const buttons = document.querySelectorAll('.lang .pill');
const heElems = document.querySelectorAll('.he');
const enElems = document.querySelectorAll('.en');

buttons.forEach(btn => {
  btn.addEventListener('click', () => {
    const isHe = btn.dataset.lang === 'he';
    buttons.forEach(b => b.setAttribute('aria-pressed', (b===btn).toString()));
    heElems.forEach(el => el.style.display = isHe ? '' : 'none');
    enElems.forEach(el => el.style.display = isHe ? 'none' : '');
    document.documentElement.dir = isHe ? 'rtl' : 'ltr';
    document.documentElement.lang = isHe ? 'he' : 'en';
  });
});
