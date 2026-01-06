
import UserAgent from 'user-agents';

const ua = new UserAgent({ deviceCategory: 'desktop', platform: 'Win32' });
console.log('Random UA:', ua.toString());
console.log('Data:', JSON.stringify(ua.data, null, 2));
