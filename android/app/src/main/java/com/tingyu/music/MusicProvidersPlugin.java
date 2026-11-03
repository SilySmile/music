package com.tingyu.music;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import org.json.JSONObject;

@CapacitorPlugin(name = "MusicProviders")
public class MusicProvidersPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("id", ""); if (!id.matches("[a-zA-Z0-9_-]{1,100}")) { call.reject("音源请求标识无效"); return; }
        executor.execute(() -> { try { JSONObject data = call.getObject("data"); call.resolve(new JSObject(ProviderApi.call(getContext(), call.getString("provider", ""), call.getString("action", ""), data == null ? new JSONObject() : data, id).toString())); } catch (Exception error) { call.reject(error.getMessage() == null ? "音乐平台请求失败" : error.getMessage()); } });
    }
    @PluginMethod public void cancel(PluginCall call) { ProviderApi.cancel(call.getString("id", "")); ProviderDownloads.cancel(call.getString("id", "")); call.resolve(); }
    @PluginMethod public void download(PluginCall call) { executor.execute(() -> { try { call.resolve(new JSObject(ProviderDownloads.download(getContext(), call.getString("id", ""), call.getString("provider", ""), call.getString("url", "")).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }); }
    @PluginMethod public void downloadState(PluginCall call) { try { call.resolve(new JSObject(ProviderDownloads.state(call.getString("id", "")).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }
    @PluginMethod public void readDownload(PluginCall call) { executor.execute(() -> { try { call.resolve(new JSObject(ProviderDownloads.read(call.getString("token", ""), call.getLong("offset", -1L), call.getInt("length", -1)).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }); }
    @PluginMethod public void removeDownload(PluginCall call) { try { ProviderDownloads.remove(call.getString("token", "")); call.resolve(); } catch (Exception error) { call.reject(error.getMessage()); } }
    @Override protected void handleOnDestroy() { executor.shutdownNow(); }
}
