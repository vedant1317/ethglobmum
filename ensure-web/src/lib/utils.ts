import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const shortAddress = (value?: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Not available";
export const shortCid = (value?: string) => value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "Not available";

export function formatDate(value?: string | number) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function etherscanTx(hash?: string) {
  return hash ? `https://sepolia.etherscan.io/tx/${hash}` : undefined;
}
