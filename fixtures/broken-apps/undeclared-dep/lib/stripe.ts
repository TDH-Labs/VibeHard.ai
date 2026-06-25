// Imports a REAL npm package that is NOT declared in package.json — the build fails
// "Module not found: Can't resolve 'stripe'". Fix: deterministic `npm install stripe`.
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
