import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "I-AM-SAM — Software Automatic Mouth Generator",
  description:
    "Classic 1982 Software Automatic Mouth voice generator. Type text, tune pitch, speed, throat and mouth, play and save as WAV. Runs entirely in your browser.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
