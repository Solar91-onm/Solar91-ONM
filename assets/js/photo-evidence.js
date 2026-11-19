(function (global) {
  "use strict";

  function submissionId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
      var value = Math.random() * 16 | 0;
      return (char === "x" ? value : (value & 3 | 8)).toString(16);
    });
  }

  function scaled(file) {
    function encode(image, close) {
      var width = image.width || image.naturalWidth;
      var height = image.height || image.naturalHeight;
      if (!width || !height || !global.document.createElement) {
        if (close) close();
        return Promise.resolve({ blob: file, name: file.name });
      }
      var scale = Math.min(1, 2048 / Math.max(width, height));
      if (scale === 1) {
        if (close) close();
        return Promise.resolve({ blob: file, name: file.name });
      }
      var canvas = global.document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      var context = canvas.getContext("2d");
      if (!context) {
        if (close) close();
        return Promise.resolve({ blob: file, name: file.name });
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (close) close();
      return new Promise(function (resolve) {
        try {
          canvas.toBlob(function (blob) {
            resolve(blob ? {
              blob: blob,
              name: file.name.replace(/\.[^.]+$/, "") + ".webp"
            } : { blob: file, name: file.name });
          }, "image/webp", 0.8);
        } catch (_error) {
          resolve({ blob: file, name: file.name });
        }
      });
    }

    if (typeof global.createImageBitmap === "function") {
      return global.createImageBitmap(file).then(function (image) {
        return encode(image, function () { image.close(); });
      }).catch(function () {
        return { blob: file, name: file.name };
      });
    }
    return new Promise(function (resolve) {
      var url = global.URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        encode(image, function () { global.URL.revokeObjectURL(url); }).then(resolve);
      };
      image.onerror = function () {
        global.URL.revokeObjectURL(url);
        resolve({ blob: file, name: file.name });
      };
      image.src = url;
    });
  }

  function upload(options) {
    return Promise.all(options.files.map(scaled)).then(function (files) {
      var body = new FormData();
      body.append("plant_id", options.plantId);
      body.append("category", options.category);
      body.append("link_type", options.linkType);
      body.append("link_id", options.linkId);
      body.append("submission_id", options.submissionId || submissionId());
      if (options.phase) body.append("phase", options.phase);
      if (options.slot !== undefined && options.slot !== null) body.append("slot", String(options.slot));
      files.forEach(function (file) { body.append("files", file.blob, file.name); });
      return global.Solar91PortalAPI.request("/api/photos", { method: "POST", body: body });
    });
  }

  function fetchBlob(url) {
    if (typeof global.clerkToken !== "function") {
      return Promise.reject(new Error("Solar91 sign-in is not ready. Reload the page."));
    }
    return global.clerkToken().then(function (token) {
      var headers = {};
      if (token) headers.Authorization = "Bearer " + token;
      return fetch(url, { headers: headers });
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.detail || "Photo could not be loaded.");
        });
      }
      return response.blob();
    });
  }

  function watch(root) {
    if (!root || !root.querySelectorAll) return;
    var images = Array.prototype.slice.call(root.querySelectorAll("img[data-photo-src]:not([data-photo-observed])"));
    if (!images.length) return;
    if (!global.IntersectionObserver) {
      images.forEach(function (image) {
        if (image.getBoundingClientRect().top < global.innerHeight + 100) loadThumbnail(image);
      });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadThumbnail(entry.target);
      });
    }, { rootMargin: "100px" });
    images.forEach(function (image) {
      image.dataset.photoObserved = "true";
      observer.observe(image);
    });
  }

  function loadThumbnail(image) {
    image.dataset.photoLoading = "true";
    fetchBlob(image.dataset.photoSrc).then(function (blob) {
      image.src = global.URL.createObjectURL(blob);
      image.dataset.photoLoaded = "true";
    }).catch(function () {
      image.alt = "Photo preview unavailable";
    });
  }

  function open(photo) {
    var isPdf = photo.contentType === "application/pdf";
    var overlay = global.document.createElement("div");
    overlay.className = "ep-photo-viewer";
    overlay.innerHTML = '<div class="ep-photo-viewer__backdrop" data-photo-close></div>' +
      '<section class="ep-photo-viewer__dialog" role="dialog" aria-modal="true" aria-label="' +
        (isPdf ? "PDF evidence" : "Photo evidence") + '">' +
        '<button type="button" class="ep-photo-viewer__close" data-photo-close aria-label="Close evidence">×</button>' +
        '<p class="ep-photo-viewer__status" role="status">' + (isPdf ? "Loading PDF…" : "Loading photo…") + '</p>' +
        '<img alt="Photo evidence" width="' + Math.max(1, Number(photo.width) || 480) +
          '" height="' + Math.max(1, Number(photo.height) || 360) + '" hidden />' +
        (isPdf
          ? '<div class="ep-photo-viewer__document" hidden><p></p><a class="ep-photo-viewer__download" download>Download PDF</a></div>'
          : "") +
        (photo.originalPurgedAt
          ? '<p class="ep-photo-viewer__notice">' +
            (isPdf ? "The original PDF was removed after 30 days." : "Full-resolution photo was removed after 30 days.") +
            '</p>' : "") +
      '</section>';
    global.document.body.appendChild(overlay);
    var image = overlay.querySelector("img");
    var status = overlay.querySelector(".ep-photo-viewer__status");
    var objectUrl = "";
    function close() {
      global.document.removeEventListener("keydown", onKey);
      if (objectUrl) global.URL.revokeObjectURL(objectUrl);
      overlay.remove();
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    overlay.addEventListener("click", function (event) {
      if (event.target.closest("[data-photo-close]")) close();
    });
    global.document.addEventListener("keydown", onKey);
    if (isPdf && photo.originalPurgedAt) {
      status.textContent = "The original PDF is no longer available.";
      return;
    }
    fetchBlob(photo.originalUrl).then(function (blob) {
      objectUrl = global.URL.createObjectURL(blob);
      if (isPdf) {
        var documentPreview = overlay.querySelector(".ep-photo-viewer__document");
        var download = overlay.querySelector(".ep-photo-viewer__download");
        documentPreview.querySelector("p").textContent = photo.fileName || "Module Cleaning evidence";
        download.href = objectUrl;
        download.download = photo.fileName || "evidence.pdf";
        documentPreview.hidden = false;
      } else {
        image.src = objectUrl;
        image.hidden = false;
      }
      status.remove();
    }).catch(function (error) {
      status.textContent = error.message || "Photo could not be loaded.";
    });
  }

  /**
   * Downscale a set of files without sending them anywhere, for the one upload that still
   * posts raw bytes (a ticket's resolution photos, whose ids the resolve call needs). The
   * bytes that reach Storage are the prepared ones either way.
   */
  function prepare(files) {
    return Promise.all(files.map(scaled));
  }

  global.Solar91PhotoEvidence = {
    submissionId: submissionId,
    prepare: prepare,
    upload: upload,
    watch: watch,
    open: open
  };
}(window));
