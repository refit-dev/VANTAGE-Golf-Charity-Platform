import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { supabase } from "@/lib/supabase";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("Stripe-Signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Guard: both signature and secret must be present
  if (!signature || !webhookSecret) {
    console.warn("Webhook: missing signature or secret");
    return new NextResponse("Missing webhook credentials", { status: 400 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (error) {
    // Log internally but return generic message to client
    console.error("Webhook signature verification failed:", error);
    return new NextResponse("Webhook signature verification failed", { status: 400 });
  }

  const session = event.data.object as any;

  if (event.type === "checkout.session.completed") {
    // Guard: session.subscription can be null for one-time payments
    if (!session.subscription) {
      console.log("checkout.session.completed: no subscription (one-time payment), skipping.");
      return new NextResponse(null, { status: 200 });
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
      const userId = session.metadata?.userId;
      const charityId = session.metadata?.charityId;
      const charityPct = parseInt(session.metadata?.charityPct || "10", 10);

      if (userId) {
        const { error } = await supabase
          .from("profiles")
          .update({
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            sub_status: subscription.status,
            current_period_end: new Date((getSubscriptionPeriodEnd(subscription as any) as any) * 1000).toISOString(),
            charity_name: charityId,
            charity_pct: charityPct,
          })
          .eq("id", userId);

        if (error) console.error("Error updating profile in webhook:", error);
      }
    } catch (err) {
      console.error("checkout.session.completed handler error:", err);
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    // Guard: subscription might be null for one-time invoices
    if (!(getInvoiceSubscription(session))) {
      console.log("invoice.payment_succeeded: no subscription, skipping.");
      return new NextResponse(null, { status: 200 });
    }

    try {
      const subscription = await stripe.subscriptions.retrieve((getInvoiceSubscription(session)) as string);
      await supabase
        .from("profiles")
        .update({
          sub_status: subscription.status,
          current_period_end: new Date((getSubscriptionPeriodEnd(subscription as any) as any) * 1000).toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);
    } catch (err) {
      console.error("invoice.payment_succeeded handler error:", err);
    }
  }

  return new NextResponse(null, { status: 200 });
}
