import { NextResponse } from "next/server";
import { stripe, ALLOWED_PRICE_IDS } from "@/lib/stripe";
import { supabase } from "@/lib/supabase";

export async function POST(req: Request) {
  try {
    const { priceId, userId, charityId, charityPct } = await req.json();

    if (!userId || !priceId) {
      return new NextResponse("User ID and Price ID are required", { status: 400 });
    }

    // Validate priceId against server-side whitelist — reject unknown IDs
    const canonicalPriceId = ALLOWED_PRICE_IDS[priceId] || ALLOWED_PRICE_IDS[
      Object.keys(ALLOWED_PRICE_IDS).find(k => ALLOWED_PRICE_IDS[k] === priceId) || ""
    ];

    if (!canonicalPriceId) {
      console.warn("Invalid priceId attempted:", priceId);
      return new NextResponse("Invalid price selection", { status: 400 });
    }

    // Validate and sanitize charityPct (must be 0-100)
    const rawPct = Number(charityPct);
    const safePct = Number.isFinite(rawPct) && rawPct >= 0 && rawPct <= 100
      ? String(Math.round(rawPct))
      : "10"; // safe default

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      allowed_payment_method_types: ["card"],
      line_items: [{ price: canonicalPriceId, quantity: 1 }],
      metadata: {
        userId,
        charityId: charityId || "general",
        charityPct: safePct,
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?checkout=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/subscription?checkout=cancelled`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
