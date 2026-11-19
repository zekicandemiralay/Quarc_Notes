package com.quarc.notes;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Quarc Store single sign-on — the app side. JS name: QuarcSso.
 *
 * Source of truth: Quarc_Store/sso-kit/android/QuarcSsoPlugin.java. Every
 * Quarc app carries an identical copy; only the package line differs.
 *
 * If Quarc Store is installed and signed in, this asks it for a login made
 * just for this app and writes it into this app's WebView cookie jar as the
 * same httpOnly "token" cookie a normal login would set — so the rest of the
 * app can't tell the difference. If the Store isn't installed (or isn't
 * signed in), nothing happens and the app's own login screen works as
 * always: the Store is optional.
 *
 * The Store's answer carries an "epoch" that changes whenever its login
 * changes (sign in, switch account, sign out). This app remembers the last
 * epoch it applied and only acts when it changes, so:
 *   - signing in to the Store signs this app in (Store wins),
 *   - signing out of the Store signs this app out,
 *   - but signing in to this app on its own afterwards is respected.
 */
@CapacitorPlugin(name = "QuarcSso")
public class QuarcSsoPlugin extends Plugin {

    private static final String STORE_PACKAGE = "com.quarc.store";
    private static final String AUTHORITY = "com.quarc.store.sso";
    private static final String PREFS = "quarc_sso_client";
    private static final String KEY_APPLIED_EPOCH = "applied_epoch";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** Is the Store here, and who is signed in to it? Changes nothing. */
    @PluginMethod
    public void peek(PluginCall call) {
        executor.execute(() -> {
            JSObject r = new JSObject();
            r.put("installed", storeInstalled());
            Bundle st = callStore("getState");
            boolean ok = st != null && "ok".equals(st.getString("result"));
            r.put("available", ok);
            if (st != null && !ok) r.put("reason", st.getString("error"));
            if (ok) {
                r.put("state", st.getString("state"));
                putUser(r, st.getString("user"));
            }
            call.resolve(r);
        });
    }

    /**
     * Applies the Store's current login to this app if it changed since the
     * last time. force=true re-applies a signed-in Store login even if
     * unchanged (the "Continue with Quarc Store" button).
     *
     * result: unavailable | denied | unchanged | none | signed_in | signed_out | error
     */
    @PluginMethod
    public void sync(PluginCall call) {
        String origin = call.getString("serverOrigin");
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        if (origin == null || !origin.startsWith("https://")) {
            call.reject("An https serverOrigin is required");
            return;
        }
        executor.execute(() -> {
            JSObject r = new JSObject();
            try {
                Bundle st = callStore("getState");
                if (st == null) {
                    r.put("result", "unavailable");
                    call.resolve(r);
                    return;
                }
                if (!"ok".equals(st.getString("result"))) {
                    r.put("result", "denied");
                    r.put("reason", st.getString("error"));
                    call.resolve(r);
                    return;
                }
                String state = st.getString("state", "none");
                long epoch = st.getLong("epoch");
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                long applied = prefs.getLong(KEY_APPLIED_EPOCH, -1);
                r.put("state", state);
                putUser(r, st.getString("user"));

                boolean forceSignIn = force && "signed_in".equals(state);
                if (epoch == applied && !forceSignIn) {
                    r.put("result", "unchanged");
                    call.resolve(r);
                    return;
                }

                if ("signed_in".equals(state)) {
                    Bundle tk = callStore("getToken");
                    String token = tk == null ? null : tk.getString("token");
                    if (tk != null && "ok".equals(tk.getString("result")) && token == null && "signed_out".equals(tk.getString("state"))) {
                        // The Store's own session turned out to be revoked.
                        clearCookie(origin);
                        prefs.edit().putLong(KEY_APPLIED_EPOCH, tk.getLong("epoch")).apply();
                        r.put("state", "signed_out");
                        r.put("result", "signed_out");
                    } else if (token == null) {
                        // Offline or server trouble: keep whatever we have, retry next time.
                        r.put("result", "error");
                        r.put("reason", tk == null ? "no_answer" : tk.getString("error", "unknown"));
                    } else {
                        long expiresAt = tk.getLong("expiresAt", 0);
                        long maxAge = expiresAt > 0 ? Math.max(60, expiresAt - System.currentTimeMillis() / 1000) : 365L * 86400;
                        setCookie(origin, token, maxAge);
                        prefs.edit().putLong(KEY_APPLIED_EPOCH, epoch).apply();
                        putUser(r, tk.getString("user"));
                        r.put("result", "signed_in");
                    }
                } else if ("signed_out".equals(state)) {
                    clearCookie(origin);
                    prefs.edit().putLong(KEY_APPLIED_EPOCH, epoch).apply();
                    r.put("result", "signed_out");
                } else {
                    // Store never signed in on this phone: leave this app's own login alone.
                    prefs.edit().putLong(KEY_APPLIED_EPOCH, epoch).apply();
                    r.put("result", "none");
                }
            } catch (Exception e) {
                r.put("result", "error");
                r.put("reason", e.getClass().getSimpleName());
            }
            call.resolve(r);
        });
    }

    /** Opens Quarc Store: target "login", "app/<package>" or "updates". It can bring the user back here. */
    @PluginMethod
    public void openStore(PluginCall call) {
        String target = call.getString("target", "");
        String self = getContext().getPackageName();
        Uri uri = Uri.parse("quarcstore://" + target + (target.contains("?") ? "&" : "?") + "return=" + self);
        Intent i = new Intent(Intent.ACTION_VIEW, uri).setPackage(STORE_PACKAGE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        JSObject r = new JSObject();
        try {
            getContext().startActivity(i);
            r.put("opened", true);
        } catch (Exception e) {
            r.put("opened", false);
        }
        call.resolve(r);
    }

    /** Opens an https link outside the app (e.g. the Quarc Store download). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        JSObject r = new JSObject();
        if (!url.startsWith("https://")) {
            call.reject("Only https links can be opened");
            return;
        }
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            r.put("opened", true);
        } catch (Exception e) {
            r.put("opened", false);
        }
        call.resolve(r);
    }

    private boolean storeInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(STORE_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** null when the Store isn't installed (or is too old to have the provider). */
    private Bundle callStore(String method) {
        ProviderInfo pi = getContext().getPackageManager().resolveContentProvider(AUTHORITY, 0);
        // Authorities are unique per device; make sure it's really the Store's.
        if (pi == null || !STORE_PACKAGE.equals(pi.packageName)) return null;
        try {
            return getContext().getContentResolver().call(Uri.parse("content://" + AUTHORITY), method, null, null);
        } catch (Exception e) {
            return null;
        }
    }

    private static void setCookie(String origin, String token, long maxAgeSecs) {
        CookieManager cm = CookieManager.getInstance();
        cm.setCookie(origin, "token=" + token + "; Path=/; Max-Age=" + maxAgeSecs + "; Secure; HttpOnly; SameSite=None");
        cm.flush();
    }

    private static void clearCookie(String origin) {
        CookieManager cm = CookieManager.getInstance();
        cm.setCookie(origin, "token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None");
        cm.flush();
    }

    private static void putUser(JSObject r, String userJson) {
        if (userJson == null) return;
        try {
            r.put("user", new JSObject(userJson));
        } catch (Exception ignored) {
            // malformed — leave it out
        }
    }
}
