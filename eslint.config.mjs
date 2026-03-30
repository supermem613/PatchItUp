import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["out/**", "node_modules/**", "_debug/**"] },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
            },
        },
        plugins: {
            "@typescript-eslint": tseslint.plugin,
        },
    },
);
