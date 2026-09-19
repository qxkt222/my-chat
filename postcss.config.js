// Tailwind v4 迁移:
//   · tailwindcss 不再是 PostCSS 插件,改用 @tailwindcss/postcss。
//   · autoprefixer 已移除 —— v4 内建 Lightning CSS 处理厂商前缀,继续挂会重复处理。
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
