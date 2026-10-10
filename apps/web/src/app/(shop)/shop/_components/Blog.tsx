"use client";

import type { MouseEvent } from "react";

interface Post {
  img: string;
  alt: string;
  day: string;
  month: string;
  tag: string;
  title: string;
  author: string;
  comments: number;
}

const POSTS: Post[] = [
  {
    img: "/shop-assets/img/blog/1.jpg",
    alt: "Món ăn nhanh lành mạnh",
    day: "14",
    month: "Th3",
    tag: "Ẩm thực & Sức khoẻ",
    title: "Đồ ăn nhanh lành mạnh: Hoang đường hay hiện thực tươi đẹp?",
    author: "Hoàng Minh Tâm",
    comments: 24,
  },
  {
    img: "/shop-assets/img/blog/2.jpg",
    alt: "Nghiên cứu về đồ ăn nhanh",
    day: "28",
    month: "Th2",
    tag: "Khoa học món ăn",
    title: "Đồ ăn nhanh có đang lành mạnh hơn? Đây là điều chúng tôi tìm thấy",
    author: "Vũ Thanh Hương",
    comments: 18,
  },
  {
    img: "/shop-assets/img/blog/3.jpg",
    alt: "Công thức đậu gà giòn cay",
    day: "05",
    month: "Th1",
    tag: "Công thức",
    title: "Công thức đậu gà giòn cay tự làm tại nhà cực dễ",
    author: "Bếp trưởng Đức",
    comments: 32,
  },
];

const noNav = (e: MouseEvent<HTMLAnchorElement>) => e.preventDefault();

export function Blog() {
  return (
    <section id="blog">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Tin tức & Cập nhật</span>
          <h2 className="stitle">
            Bài viết <span>mới nhất</span>
          </h2>
          <div className="sline" />
        </div>
        <div className="row g-4">
          {POSTS.map((p, i) => (
            <div key={p.title} className="col-md-6 col-lg-4" data-aos="fade-up" data-aos-delay={String(i * 80)}>
              <div className="blcard">
                <div className="blimg">
                  <img src={p.img} alt={p.alt} loading="lazy" />
                  <div className="bldatebdg">
                    <span className="bd">{p.day}</span>
                    <span className="bm">{p.month}</span>
                  </div>
                </div>
                <div className="blbody">
                  <div className="bltag">{p.tag}</div>
                  <div className="bltit">
                    <a href="#" onClick={noNav}>
                      {p.title}
                    </a>
                  </div>
                  <div className="blmeta">
                    <span>
                      <i className="fas fa-user" />
                      {p.author}
                    </span>
                    <span>
                      <i className="fas fa-comment" />
                      {p.comments} bình luận
                    </span>
                  </div>
                  <a href="#" className="blmore" onClick={noNav}>
                    Đọc tiếp <i className="fas fa-arrow-right" />
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
