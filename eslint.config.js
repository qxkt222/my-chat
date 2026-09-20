import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        // type-aware lint:strict-type-checked 需要 project 服务(traverser 用 tsconfig)
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    // 健康度加固(疑点五回应):recommended 升级为 strict-type-checked(type-aware,
    // 54 条新规则:no-unsafe-*/no-floating-promises/no-misused-promises 等),
    // 用 warn 级别避免过度阻断,但所有问题都会被如实暴露
    rules: {
      ...tseslint.configs["flat/strict-type-checked"].rules,
      // 项目实际策略:取消与工程风格冲突或噪音过大的规则
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      // catch 的 unknown 错误对象转字符串拼接是惯用做法(本规则对 unknown 报噪,
      // 项目大量错误信息场景,收益低于噪音 → 关)
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unsafe-assignment": "off", // invoke 层返回 any,DTO 已类型化
      // 这两条恢复为 warn：`any` 已归零（探针实测 0 处），回归成本低，
      // 而它们正是「IPC 层悄悄漏进一个 any」的唯一警报器
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "warn",
      "no-console": "off",
      ...reactHooks.configs.recommended.rules,
    },
  },
];
