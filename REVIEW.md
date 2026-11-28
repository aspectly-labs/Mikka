# Review rules

- UI copy has no filler (`mikka-hosted-ui/docs/design/rules.md` R-40). Flag as blocking any new
  visible string that only explains the screen, narrates what will happen next
  or reassures in a full sentence: a sheet or dialog subtitle, small print such
  as 「…不保存，也不会给 AI 看」, a status line with a next step
  (「已登录，继续检查」). Reassurance is a mark (🔒 Secured by Mikka). A paid
  block's own text slots follow the same rule: a subtitle the reference product
  does not show is removed ([2026-11-27-1409](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-27-1409-top-products-over-paid-blocks.md)).
