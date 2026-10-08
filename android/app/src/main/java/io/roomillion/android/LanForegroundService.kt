package io.roomillion.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Keeps an active host process eligible to serve connections while its UI is briefly backgrounded.
 * The game room remains the authority for rules; this is not a promise of unattended game execution. */
class LanForegroundService : Service() {
    companion object {
        private const val CHANNEL = "roomillion-lan"
        fun begin(context: Context, name: String) {
            context.startForegroundService(Intent(context, LanForegroundService::class.java).putExtra("name", name))
        }
        fun end(context: Context) { context.stopService(Intent(context, LanForegroundService::class.java)) }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "局域网联机", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.roomillion_icon)
            .setContentTitle("千万间正在主持联机游戏").setContentText(intent?.getStringExtra("name") ?: "返回工作台查看游戏")
            .setContentIntent(open).setOngoing(true).build()
        startForeground(6001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        return START_NOT_STICKY
    }
}
