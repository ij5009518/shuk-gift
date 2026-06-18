// Exposes the public Clerk publishable key to the browser (safe to be public).
// If unset, the app stays in demo mode.
export default function handler(req, res) {
  res.status(200).json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || null });
}
