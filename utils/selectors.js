/**
 * DOM selectors for https://eticket.railway.gov.bd
 *
 * Confirmed against the live home page and the site's Angular bundles
 * on 2026-09-27 (home chunk 585, search-result chunk 943, purchase chunk 187).
 * Items marked CHECK still need a look in DevTools on a live results / seat map,
 * because those views require a logged-in session and were not opened here.
 */
var SELECTORS = {
  home: {
    form: "#trainsearch",
    fromInput: "#dest_from",
    toInput: "#dest_to",
    dateInput: "#doj",
    dateHidden: 'input[formcontrolname="doj"]',
    dateTrigger: "img.ui-datepicker-trigger",
    classSelect: "#choose_class",
    submit: '#trainsearch button[type="submit"]',
    suggestionList: "ul.ui-autocomplete",
    suggestionItem: "ul.ui-autocomplete li.ui-menu-item a",
    datepicker: "#ui-datepicker-div",
    datepickerNext: "#ui-datepicker-div .ui-datepicker-next",
    datepickerPrev: "#ui-datepicker-div .ui-datepicker-prev",
    datepickerMonth: "#ui-datepicker-div .ui-datepicker-month",
    datepickerYear: "#ui-datepicker-div .ui-datepicker-year",
    datepickerDay: '#ui-datepicker-div td[data-handler="selectDay"] a'
  },
  results: {
    // CHECK: card is in the bundle; confirm it is the visible train block.
    trainList: ".single-trip-wrapper",
    trainName: ".trip-name",
    trainNumber: ".trip-name h2",
    classColumn: ".single-seat-class",
    className: ".seat-class-name",
    availableCount: ".all-seats, .online-seats",
    unavailableWrap: ".no-seat-available-wrap",
    bookNow: "button.book-now-btn"
  },
  seats: {
    // CHECK: class names come from the Angular ngClass map, not a live seat click.
    layout: ".seat-layout-view",
    coachSelect: "#select-bogie",
    coachOption: "#select-bogie option",
    seatButton: "button.btn-seat",
    available: "seat-available",
    booked: "seat-booked",
    selected: "seat-selected",
    disabled: "seat-disabled",
    inProgress: "seat-in-progress",
    hidden: "seat-hidden",
    pending: "request_pending",
    boardingSelect: "#boardingpoint",
    continueButton: "button.continue-btn",
    continueForm: "#confirmbooking"
  },
  otp: {
    // CHECK: component is in the purchase bundle. Confirm it is mounted
    // when the "Enter Your OTP Code" screen is actually visible.
    container: "app-confirm-booking-otp, .confirm-ticket-otp, .confirm-ticket-otp-wrapper, .otp-verification-card-header",
    heading: "h1, h2, h3, h4, h5, .confirm-ticket-otp-header, .otp-verification-card-header, .heading-div"
  },
  payment: {
    // URL/path only. Do not click these.
    path: /payment|checkout|bkash|nagad|sslcommerz/i
  },
  dialog: {
    container: ".swal2-popup",
    title: ".swal2-title",
    body: ".swal2-html-container",
    confirm: ".swal2-confirm",
    cancel: ".swal2-cancel"
  }
};
