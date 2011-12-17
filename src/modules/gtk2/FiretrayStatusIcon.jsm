/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://firetray/cairo.jsm");
Cu.import("resource://firetray/gobject.jsm");
Cu.import("resource://firetray/gdk.jsm");
Cu.import("resource://firetray/gtk.jsm");
Cu.import("resource://firetray/libc.jsm");
Cu.import("resource://firetray/pango.jsm");
Cu.import("resource://firetray/commons.js");

const Services2 = {};
XPCOMUtils.defineLazyServiceGetter(
  Services2,
  "uuid",
  "@mozilla.org/uuid-generator;1",
  "nsIUUIDGenerator"
);

if ("undefined" == typeof(firetray.Handler))
  ERROR("FiretrayIcon*.jsm MUST be imported from/after FiretrayHandler !");

// pointers to JS functions. should *not* be eaten by GC ("Running global
// cleanup code from study base classes" ?)
var firetray_iconActivateCb;
var firetray_popupMenuCb;
var firetray_menuItemQuitActivateCb;
var firetray_findGtkWindowByTitleCb;
var firetray_windowDeleteCb;
var firetray_windowStateCb;

/**
 * custum type used to pass data in to and out of firetray_findGtkWindowByTitleCb
 */
var _find_data_t = ctypes.StructType("_find_data_t", [
  { inTitle: ctypes.char.ptr },
  { outWindow: gtk.GtkWindow.ptr }
]);


firetray.StatusIcon = {
  trayIcon: null,
  menu: null,
  MIN_FONT_SIZE: 4,

  init: function() {
    try {
      // init tray icon, some variables
      this.trayIcon  = gtk.gtk_status_icon_new();
    } catch (x) {
      ERROR(x);
      return false;
    }

    firetray.Handler.setImageDefault();

    this._buildPopupMenu();

    firetray.Handler.setTooltipDefault();

    // attach popupMenu to trayIcon
    try {

      /* GTK TEST. initWindow should be done somewhere else
         (Firetray.WindowLinux ?) */
      let win = Services.wm.getMostRecentWindow(null);
      /* NOTE: it should not be necessary to cast gtkWin to a GtkWidget, nor
         gtk_widget_add_events(gtkWin, gdk.GDK_ALL_EVENTS_MASK); */
      let gtkWin = this.getGtkWindowHandle(win);
      LOG("gtkWin="+gtkWin);
      let gdkWin = gtk.gtk_widget_get_window(
        ctypes.cast(gtkWin, gtk.GtkWidget.ptr));
      LOG("gdkWin="+gdkWin);

      firetray_iconActivateCb = gtk.GCallbackStatusIconActivate_t(firetray.StatusIcon.showHideToTray);
      // gobject.g_signal_connect(this.trayIcon, "activate", firetray_iconActivateCb, null);
      gobject.g_signal_connect(this.trayIcon, "activate", firetray_iconActivateCb, gdkWin); // TEST

      /* delete_event_cb (in gtk2/nsWindow.cpp) prevents us from catching
         "delete-event" */

      let deleteEventId = gobject.g_signal_lookup("delete-event", gtk.gtk_window_get_type());
      LOG("deleteEventId="+deleteEventId);
      let deleteEventHandler = gobject.g_signal_handler_find(gtkWin, gobject.G_SIGNAL_MATCH_ID, deleteEventId, 0, null, null, null);
      LOG("deleteEventHandler="+deleteEventHandler);
      gobject.g_signal_handler_block(gtkWin, deleteEventHandler); // not _disconnect

      firetray_windowDeleteCb = gtk.GCallbackGenericEvent_t(firetray.StatusIcon.windowDelete);
      // let res = gobject.g_signal_connect(gtkWin, "delete_event", firetray_windowDeleteCb, null);
      let res = gobject.g_signal_connect(gtkWin, "delete_event", firetray_windowDeleteCb, null);
      LOG("g_connect delete-event="+res);


      /* we'll catch minimize events with Gtk:
       http://stackoverflow.com/questions/8018328/what-is-the-gtk-event-called-when-a-window-minimizes */
      firetray_windowStateCb = gtk.GCallbackGenericEvent_t(firetray.StatusIcon.windowState);
      res = gobject.g_signal_connect(gtkWin, "window-state-event", firetray_windowStateCb, null);
      LOG("g_connect window-state-event="+res);

    } catch (x) {
      ERROR(x);
      return false;
    }

    return true;
  },

  shutdown: function() {
    cairo.close();
    // glib.close();
    gobject.close();
    gdk.close();
    gtk.close();
    pango.close();
  },

  _buildPopupMenu: function() {
    this.menu = gtk.gtk_menu_new();
    // shouldn't need to convert to utf8 thank to js-ctypes
		var menuItemQuitLabel = firetray.Utils.strings.GetStringFromName("popupMenu.itemLabel.Quit");
    var menuItemQuit = gtk.gtk_image_menu_item_new_with_label(
      menuItemQuitLabel);
    var menuItemQuitIcon = gtk.gtk_image_new_from_stock(
      "gtk-quit", gtk.GTK_ICON_SIZE_MENU);
    gtk.gtk_image_menu_item_set_image(menuItemQuit, menuItemQuitIcon);
    var menuShell = ctypes.cast(this.menu, gtk.GtkMenuShell.ptr);
    gtk.gtk_menu_shell_append(menuShell, menuItemQuit);

    firetray_menuItemQuitActivateCb = gobject.GCallback_t(
      function(){firetray.Handler.quitApplication();});
    gobject.g_signal_connect(menuItemQuit, "activate",
                             firetray_menuItemQuitActivateCb, null);

    var menuWidget = ctypes.cast(this.menu, gtk.GtkWidget.ptr);
    gtk.gtk_widget_show_all(menuWidget);

    /* NOTE: here we do use a function handler (instead of a function
       definition) because we need the args passed to it ! As a consequence, we
       need to abandon 'this' in popupMenu() */
    let that = this;
    firetray_popupMenuCb =
      gtk.GCallbackMenuPopup_t(that.popupMenu);
    gobject.g_signal_connect(this.trayIcon, "popup-menu",
                             firetray_popupMenuCb, this.menu);
  },

  popupMenu: function(icon, button, activateTime, menu) {
    LOG("MENU POPUP");
    LOG("ARGS="+icon+", "+button+", "+activateTime+", "+menu);

    try {
      var gtkMenuPtr = ctypes.cast(menu, gtk.GtkMenu.ptr);
      var iconGpointer = ctypes.cast(icon, gobject.gpointer);
      gtk.gtk_menu_popup(
        gtkMenuPtr, null, null, gtk.gtk_status_icon_position_menu,
        iconGpointer, button, activateTime);
    } catch (x) {
      LOG(x);
    }

  },

  /**
   * Iterate over all Gtk toplevel windows to find a window. We rely on
   * Service.wm to watch windows correctly: we should find only one window.
   *
   * @author Nils Maier (stolen from MiniTrayR)
   * @param window nsIDOMWindow from Services.wm
   * @return a gtk.GtkWindow.ptr
   */
  getGtkWindowHandle: function(window) {
    let baseWindow = window
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIWebNavigation)
      .QueryInterface(Ci.nsIBaseWindow);

    // Tag the base window
    let oldTitle = baseWindow.title;
    baseWindow.title = Services2.uuid.generateUUID().toString();

    try {
      // Search the window by the *temporary* title
      let widgets = gtk.gtk_window_list_toplevels();
      let that = this;
      firetray_findGtkWindowByTitleCb = gobject.GFunc_t(that._findGtkWindowByTitle);
      var userData = new _find_data_t(
        ctypes.char.array()(baseWindow.title),
        null
      ).address();
      LOG("userData="+userData);
      gobject.g_list_foreach(widgets, firetray_findGtkWindowByTitleCb, userData);
      gobject.g_list_free(widgets);

      if (userData.contents.outWindow.isNull()) {
        throw new Error("Window not found!");
      }
      LOG("found window: "+userData.contents.outWindow);
    } catch (x) {
      ERROR(x);
    } finally {
      // Restore
      baseWindow.title = oldTitle;
    }

    return userData.contents.outWindow;
  },

  /**
   * compares a GtkWindow's title with a string passed in userData
   * @param gtkWidget: GtkWidget from gtk_window_list_toplevels()
   * @param userData: _find_data_t
   */
  _findGtkWindowByTitle: function(gtkWidget, userData) {
    LOG("GTK Window: "+gtkWidget+", "+userData);

    let data = ctypes.cast(userData, _find_data_t.ptr);
    let inTitle = data.contents.inTitle;
    LOG("inTitle="+inTitle.readString());

    let gtkWin = ctypes.cast(gtkWidget, gtk.GtkWindow.ptr);
    let winTitle = gtk.gtk_window_get_title(gtkWin);

    try {
      if (!winTitle.isNull()) {
        LOG(inTitle+" = "+winTitle);
        if (libc.strcmp(inTitle, winTitle) == 0)
          data.contents.outWindow = gtkWin;
      }
    } catch (x) {
      ERROR(x);
    }
  },

  // FIXME: it may not be worth wrapping gtk_widget_get_window...
  getGdkWindowFromGtkWindow: function(gtkWin) {
    try {
      let gtkWid = ctypes.cast(gtkWin, gtk.GtkWidget.ptr);
      var gdkWin = gtk.gtk_widget_get_window(gtkWid);
    } catch (x) {
      ERROR(x);
    }
    return gdkWin;
  },

  getGdkWindowHandle: function(win) {
    try {
      let gtkWin = firetray.StatusIcon.getGtkWindowHandle(win);
      LOG("FOUND: "+gtk.gtk_window_get_title(gtkWin).readString());
      let gdkWin = this.getGdkWindowFromGtkWindow(gtkWin);
      if (!gdkWin.isNull()) {
        LOG("has window");
        return gdkWin;
      }
    } catch (x) {
      ERROR(x);
    }
    return null;
  },

  showHideToTray: function(gtkStatusIcon, userData){
    LOG("showHideToTray: "+userData);
    try {
      let gdkWin = ctypes.cast(userData, gdk.GdkWindow.ptr);
      gdk.gdk_window_show(gdkWin);
    } catch (x) {
      ERROR(x);
    }

    let stopPropagation = true;
    return stopPropagation;
  },

  windowDelete: function(gtkWidget, gdkEv, userData){
    LOG("gtk_widget_hide: "+gtkWidget+", "+gdkEv+", "+userData);
    try{
      let gdkWin = firetray.StatusIcon.getGdkWindowFromGtkWindow(gtkWidget);
      gdk.gdk_window_hide(gdkWin);
    } catch (x) {
      ERROR(x);
    }
    let stopPropagation = true;
    return stopPropagation;
  },

  windowState: function(gtkWidget, gdkEv, userData){
    LOG("window-state-event");
    let stopPropagation = true;
    return stopPropagation;
  }

}; // firetray.StatusIcon

firetray.Handler.setImage = function(filename) {
  if (!firetray.StatusIcon.trayIcon)
    return false;
  LOG(filename);

  try {
    gtk.gtk_status_icon_set_from_file(firetray.StatusIcon.trayIcon,
                                      filename);
  } catch (x) {
    ERROR(x);
    return false;
  }
  return true;
};

firetray.Handler.setImageDefault = function() {
  if (!this.FILENAME_DEFAULT)
    throw "Default application icon filename not set";
  this.setImage(this.FILENAME_DEFAULT);
};

// GTK bug: Gdk-CRITICAL **: IA__gdk_window_get_root_coords: assertion `GDK_IS_WINDOW (window)' failed
firetray.Handler.setTooltip = function(toolTipStr) {
  if (!firetray.StatusIcon.trayIcon)
    return false;

  try {
    gtk.gtk_status_icon_set_tooltip_text(firetray.StatusIcon.trayIcon,
                                         toolTipStr);
  } catch (x) {
    ERROR(x);
    return false;
  }
  return true;
};

firetray.Handler.setTooltipDefault = function() {
  if (!this.appName)
    throw "application name not initialized";
  this.setTooltip(this.appName);
};

firetray.Handler.setText = function(text, color) { // TODO: split into smaller functions;
  LOG("setText, color="+color);
  if (typeof(text) != "string")
    throw new TypeError();

  try {
    // build background from image
    let specialIcon = gdk.gdk_pixbuf_new_from_file(this.FILENAME_BLANK, null); // GError **error);
    let dest = gdk.gdk_pixbuf_copy(specialIcon);
    let w = gdk.gdk_pixbuf_get_width(specialIcon);
    let h = gdk.gdk_pixbuf_get_height(specialIcon);

    // prepare colors/alpha
    let colorMap = gdk.gdk_screen_get_system_colormap(gdk.gdk_screen_get_default());
    let visual = gdk.gdk_colormap_get_visual(colorMap);
    let visualDepth = visual.contents.depth;
    LOG("colorMap="+colorMap+" visual="+visual+" visualDepth="+visualDepth);
    let fore = new gdk.GdkColor;
    fore.pixel = fore.red = fore.green = fore.blue = 0;
    let alpha  = new gdk.GdkColor;
    alpha.pixel = alpha.red = alpha.green = alpha.blue = 0xFFFF;
    if (!fore || !alpha)
      WARN("Undefined GdkColor fore or alpha");
    gdk.gdk_color_parse(color, fore.address());
    if(fore.red == alpha.red && fore.green == alpha.green && fore.blue == alpha.blue) {
      alpha.red=0; // make sure alpha is different from fore
    }
    gdk.gdk_colormap_alloc_color(colorMap, fore.address(), true, true);
    gdk.gdk_colormap_alloc_color(colorMap, alpha.address(), true, true);

    // build pixmap with rectangle
    let pm = gdk.gdk_pixmap_new(null, w, h, visualDepth);
    let pmDrawable = ctypes.cast(pm, gdk.GdkDrawable.ptr);
    let cr = gdk.gdk_cairo_create(pmDrawable);
    gdk.gdk_cairo_set_source_color(cr, alpha.address());
    cairo.cairo_rectangle(cr, 0, 0, w, h);
    cairo.cairo_set_source_rgb(cr, 1, 1, 1);
    cairo.cairo_fill(cr);

    // build text
    let scratch = gtk.gtk_window_new(gtk.GTK_WINDOW_TOPLEVEL);
    let layout = gtk.gtk_widget_create_pango_layout(scratch, null);
    gtk.gtk_widget_destroy(scratch);
    let fnt = pango.pango_font_description_from_string("Sans 18");
    pango.pango_font_description_set_weight(fnt,pango.PANGO_WEIGHT_SEMIBOLD);
    pango.pango_layout_set_spacing(layout,0);
    pango.pango_layout_set_font_description(layout, fnt);
    LOG("layout="+layout);
    LOG("text="+text);
    pango.pango_layout_set_text(layout, text,-1);
    let tw = new ctypes.int;
    let th = new ctypes.int;
    let sz;
    let border = 4;
    pango.pango_layout_get_pixel_size(layout, tw.address(), th.address());
    LOG("tw="+tw.value+" th="+th.value);
    // fit text to the icon by decreasing font size
    while ( tw.value > (w - border) || th.value > (h - border) ) {
      sz = pango.pango_font_description_get_size(fnt);
      if(sz < firetray.StatusIcon.MIN_FONT_SIZE) {
        sz = firetray.StatusIcon.MIN_FONT_SIZE;
        break;
      }
      sz -= pango.PANGO_SCALE;
      pango.pango_font_description_set_size(fnt,sz);
      pango.pango_layout_set_font_description(layout, fnt);
      pango.pango_layout_get_pixel_size(layout, tw.address(), th.address());
    }
    LOG("tw="+tw.value+" th="+th.value);
    pango.pango_font_description_free(fnt);
    // center text
    let px = (w-tw.value)/2;
    let py = (h-th.value)/2;

    // draw text on pixmap
    gdk.gdk_cairo_set_source_color(cr, fore.address());
    cairo.cairo_move_to(cr, px, py);
    pangocairo.pango_cairo_show_layout(cr, layout);
    cairo.cairo_destroy(cr);
    gobject.g_object_unref(layout);

    let buf = gdk.gdk_pixbuf_get_from_drawable(null, pmDrawable, null, 0, 0, 0, 0, w, h);
    gobject.g_object_unref(pm);
    LOG("alpha="+alpha);
    let alphaRed = gobject.guint16(alpha.red);
    let alphaRed_guchar = ctypes.cast(alphaRed, gobject.guchar);
    let alphaGreen = gobject.guint16(alpha.green);
    let alphaGreen_guchar = ctypes.cast(alphaGreen, gobject.guchar);
    let alphaBlue = gobject.guint16(alpha.blue);
    let alphaBlue_guchar = ctypes.cast(alphaBlue, gobject.guchar);
    let bufAlpha = gdk.gdk_pixbuf_add_alpha(buf, true, alphaRed_guchar, alphaGreen_guchar, alphaBlue_guchar);
    gobject.g_object_unref(buf);

    // merge the rendered text on top
    gdk.gdk_pixbuf_composite(bufAlpha,dest,0,0,w,h,0,0,1,1,gdk.GDK_INTERP_NEAREST,255);
    gobject.g_object_unref(bufAlpha);

    gtk.gtk_status_icon_set_from_pixbuf(firetray.StatusIcon.trayIcon, dest);
  } catch (x) {
    ERROR(x);
    return false;
  }

  return true;
};

firetray.Handler.showHideToTray = function() {
  // How to do that ?? is called in overlay.xul
};