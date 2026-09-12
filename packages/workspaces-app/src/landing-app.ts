/**
 * The landing page's only script. `/` is a server-rendered list of
 * workspaces and stays that way; this entry defines <meeting-banner>, which
 * the shell renders above the list, and wakes the review bar: the stored size
 * choice repainted over the server's Hard, and the total that follows it. Its
 * own bundle rather than a share of board.js because the landing page must
 * stay a few KB — the banner is self-styling (shadow DOM) and needs none of
 * the app CSS.
 */
import './meeting-banner.ts';
import { browserStorage } from './boot-env.ts';
import { wakeLandingReviewBar } from './landing-review-bar.ts';

wakeLandingReviewBar(document, browserStorage);
