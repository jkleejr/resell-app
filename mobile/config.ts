// Where the app sends photos for analysis.
//
// PRODUCTION (default): the deployed Vercel backend. Works anywhere, including
// cellular — this is what ships in the App Store build.
export const BACKEND_URL = "https://resell-it-backend.vercel.app";

// LOCAL TESTING: to develop against the backend on your Mac instead, run
// `npm run dev` in the backend folder, put your machine's LAN IP below, and make
// sure your phone is on the same Wi-Fi (`ipconfig getifaddr en0` on macOS):
//   export const BACKEND_URL = "http://10.0.0.108:3000";
