package com.frontierx.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.text.format.Formatter
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import java.io.File

// In-app update sheet: version summary, release notes, live download progress
// and the handoff to the package installer. Replaces the bare system alert.
object UpdateDialog {
    private val main = Handler(Looper.getMainLooper())

    fun show(activity: Activity, release: Updater.Release) {
        if (activity.isFinishing || activity.isDestroyed) return
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_update, null)
        val versions = view.findViewById<TextView>(R.id.update_versions)
        val size = view.findViewById<TextView>(R.id.update_size)
        val notesTitle = view.findViewById<TextView>(R.id.update_notes_title)
        val notes = view.findViewById<TextView>(R.id.update_notes)
        val progress = view.findViewById<ProgressBar>(R.id.update_progress)
        val status = view.findViewById<TextView>(R.id.update_status)
        val install = view.findViewById<Button>(R.id.update_install)
        val later = view.findViewById<Button>(R.id.update_later)
        val skip = view.findViewById<Button>(R.id.update_skip)

        versions.text = activity.getString(
            R.string.update_versions_format,
            Updater.currentVersionName(activity),
            release.version,
        )
        if (release.size > 0L) {
            size.text = activity.getString(
                R.string.update_size_format,
                Formatter.formatShortFileSize(activity, release.size),
            )
        } else {
            size.visibility = View.GONE
        }
        if (release.notes.isNotBlank()) {
            notes.text = release.notes
        } else {
            notesTitle.visibility = View.GONE
            notes.visibility = View.GONE
        }

        val dialog = AlertDialog.Builder(activity)
            .setView(view)
            .setCancelable(!release.mandatory)
            .create()
        dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)
        if (release.mandatory) {
            later.visibility = View.GONE
            skip.visibility = View.GONE
        }
        later.setOnClickListener { dialog.dismiss() }
        skip.setOnClickListener {
            Updater.skipVersion(activity, release.version)
            dialog.dismiss()
        }
        install.setOnClickListener {
            if (!Updater.ensureInstallPermission(activity)) return@setOnClickListener
            install.isEnabled = false
            later.isEnabled = false
            skip.isEnabled = false
            dialog.setCancelable(false)
            progress.isIndeterminate = true
            progress.visibility = View.VISIBLE
            status.visibility = View.VISIBLE
            status.setText(R.string.update_downloading)
            run(activity, release, dialog, progress, status, install, later, skip)
        }
        dialog.show()
    }

    private fun run(
        activity: Activity,
        release: Updater.Release,
        dialog: AlertDialog,
        progress: ProgressBar,
        status: TextView,
        install: Button,
        later: Button,
        skip: Button,
    ) {
        val context = activity.applicationContext
        Thread {
            var file: File? = null
            var failure: String? = null
            try {
                file = Updater.download(context, release) { percent ->
                    main.post {
                        progress.isIndeterminate = false
                        progress.progress = percent
                        status.text = activity.getString(R.string.update_progress_format, percent)
                    }
                }
            } catch (err: Exception) {
                failure = err.message ?: context.getString(R.string.update_failed_body)
            }
            val ready = file
            main.post {
                if (activity.isFinishing || activity.isDestroyed) return@post
                if (ready == null) {
                    progress.visibility = View.GONE
                    status.text = failure ?: context.getString(R.string.update_failed_body)
                    install.isEnabled = true
                    later.isEnabled = true
                    skip.isEnabled = true
                    install.setText(R.string.update_retry)
                    dialog.setCancelable(true)
                    return@post
                }
                progress.isIndeterminate = false
                progress.progress = 100
                status.setText(R.string.update_ready)
                Updater.install(activity, ready)
                main.postDelayed({ if (dialog.isShowing) dialog.dismiss() }, 1500L)
            }
        }.start()
    }
}