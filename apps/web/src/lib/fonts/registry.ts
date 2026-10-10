import { Be_Vietnam_Pro, Inter, JetBrains_Mono, Noto_Sans, Roboto } from "next/font/google";

// Chỉ giữ font có subset "vietnamese" — giao diện tiếng Việt, font thiếu dấu sẽ vỡ chữ.
const inter = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-inter" });
const beVietnamPro = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-be-vietnam-pro",
});
const notoSans = Noto_Sans({ subsets: ["latin", "vietnamese"], variable: "--font-noto-sans" });
const roboto = Roboto({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "700"], variable: "--font-roboto" });
const jetBrainsMono = JetBrains_Mono({ subsets: ["latin", "vietnamese"], variable: "--font-jetbrains-mono" });

export const fontRegistry = {
  inter: { label: "Inter", font: inter },
  beVietnamPro: { label: "Be Vietnam Pro", font: beVietnamPro },
  notoSans: { label: "Noto Sans", font: notoSans },
  roboto: { label: "Roboto", font: roboto },
  jetBrainsMono: { label: "JetBrains Mono", font: jetBrainsMono },
} as const;

export type FontKey = keyof typeof fontRegistry;

export const fontKeys = Object.keys(fontRegistry) as FontKey[];

export const fontVars = Object.values(fontRegistry)
  .map(({ font }) => font.variable)
  .join(" ");

export const fontOptions = fontKeys.map((key) => ({
  key,
  label: fontRegistry[key].label,
}));
