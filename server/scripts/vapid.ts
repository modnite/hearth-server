// Generate a VAPID keypair for web push:
//   npm --workspace server run vapid
// Paste the two lines into .env.
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('# Paste into .env:');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
