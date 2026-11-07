import { ArrowRight, LockKeyhole } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function SignInPrompt({ title, description }: { title: string; description: string }) {
  return <div className="timeline-empty" role="status">
    <LockKeyhole className="size-8" strokeWidth={1.4} aria-hidden="true" />
    <h2>{title}</h2>
    <p>{description}</p>
    <Button asChild><Link to="/login">Sign in <ArrowRight className="size-4" /></Link></Button>
  </div>;
}
