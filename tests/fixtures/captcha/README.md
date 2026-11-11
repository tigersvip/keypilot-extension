# CAPTCHA regression fixtures

Captured on 2026-11-10 from the public image endpoint provided by the user:
`https://seajoincabinetry.com/hulingkeji.php?m=admin&c=Admin&a=vertify&lang=cn&t=9773162`.

`site-01.png` through `site-07.png` are seven independently generated images.
`user-inline-ukay.png` and `user-preview-ukay.png` are two crops of the same
user-supplied failure screenshot; they count as one unique example.
Only the CAPTCHA regions are included, with no account or password fields.
Labels were visually recorded before inference. These images were used during
development; they are regression fixtures, not an independent accuracy test.
Tests read these files offline and never request the endpoint or submit a login.

`complex-fixed/` freezes the ten existing synthetic regression cases from
`complex.ts`, rendered in Chromium on Windows. `labels.json` records the original
seed, index, font, label and PNG hash; labels were chosen before inference.
These replace runtime rendering of those same cases: Georgia/Tahoma availability,
font substitution and canvas rasterization differ across operating systems and
otherwise change the test input. The original first-candidate assertions remain.
They are development regressions, not a claim of general CAPTCHA accuracy.
Dynamic clean, arithmetic and UI canvas tests continue exercising platform rendering.
These test images are never included in the extension package.
