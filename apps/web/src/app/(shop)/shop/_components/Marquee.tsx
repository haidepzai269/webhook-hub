const ITEMS = [
  "Gà rán giòn rụm",
  "Burger thượng hạng",
  "Pizza nướng lò củi",
  "Wrap & cuốn tươi",
  "Khoai tây phô mai",
  "Sữa lắc kem",
  "Sandwich nướng",
];

/** Dải chữ chạy giữa Hero và Category (CSS animation của style.css, lặp 2 lần để cuộn liền mạch). */
export function Marquee() {
  return (
    <div className="mqsec" aria-hidden="true">
      <div className="mqtrack">
        {[...ITEMS, ...ITEMS].map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách tĩnh lặp 2 lần
          <div className="mqitem" key={i}>
            <i className="fas fa-circle" />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
