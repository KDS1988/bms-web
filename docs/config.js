// Заполните после деплоя Worker (см. README)
window.BMS_CONFIG = {
  // основной адрес — через собственный прокси (работает у пользователей, чей провайдер режет трафик Cloudflare);
  // запасной — напрямую Worker. Если основной не отвечает, доска сама переключается на запасной
  API_URLS: ['https://89-110-94-230.sslip.io', 'https://bms-web.dmitry-korneev88.workers.dev'],
  API_URL: 'https://bms-web.dmitry-korneev88.workers.dev',
  GOOGLE_CLIENT_ID: '364229231843-rukcbr3ob502tt55ocqu3r6fi1rr7lut.apps.googleusercontent.com',
};
