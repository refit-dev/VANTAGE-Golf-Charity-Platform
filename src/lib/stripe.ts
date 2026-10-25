import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable. Add it to .env.local.");
}

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2026-09-30.endive" as Stripe.LatestApiVersion,
  appInfo: {
    name: "Vantage Charity Golf",
    version: "0.1.0",
  },
});

// Whitelist of valid Stripe price IDs (add your real ones here)
export const ALLOWED_PRICE_IDS: Record<string, string> = {
  monthly: process.env.STRIPE_PRICE_MONTHLY || "price_monthly_placeholder",
  yearly: process.env.STRIPE_PRICE_YEARLY || "price_yearly_placeholder",
};
