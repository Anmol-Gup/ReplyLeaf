import { redirect } from "next/navigation";

// Kept so old links keep working: the confirmation message is now a dialog on /signup.
export default function CheckEmail() {
  redirect("/signup?sent=1");
}
